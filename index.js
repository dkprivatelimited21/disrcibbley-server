import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import wordsData from './words.json' assert { type: 'json' };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Game state storage
const rooms = {};
const players = {};

// Word lists
const wordLists = {
  easy: wordsData.easy,
  medium: [...wordsData.easy, ...wordsData.medium],
  hard: [...wordsData.easy, ...wordsData.medium, ...wordsData.hard]
};

const generateRoomCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
};

const getRandomWord = (difficulty = 'easy') => {
  const list = wordLists[difficulty] || wordLists.easy;
  return list[Math.floor(Math.random() * list.length)];
};

const calculateHint = (word, timeElapsed, roundTime) => {
  const progress = timeElapsed / roundTime;
  if (progress < 0.3) return '';
  if (progress < 0.6) return `The word has ${word.length} letters`;
  if (progress < 0.8) return `Starts with: ${word[0]}`;
  return `Starts with: ${word[0]}...${word[word.length - 1]}`;
};

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  socket.on('createRoom', (playerName, callback) => {
    const roomCode = generateRoomCode();
    const player = { id: socket.id, name: playerName, isHost: true };

    rooms[roomCode] = {
      players: [player],
      host: socket.id,
      state: 'lobby',
      settings: {}
    };

    players[socket.id] = {
      room: roomCode,
      name: playerName,
      isHost: true
    };

    socket.join(roomCode);
    callback({ roomCode });
  });

  socket.on('joinRoom', (roomCode, playerName, callback) => {
    if (!rooms[roomCode]) {
      callback({ error: 'Room not found' });
      return;
    }

    if (rooms[roomCode].state !== 'lobby') {
      callback({ error: 'Game already started' });
      return;
    }

    if (rooms[roomCode].players.length >= 8) {
      callback({ error: 'Room is full' });
      return;
    }

    const player = { id: socket.id, name: playerName, isHost: false };

    rooms[roomCode].players.push(player);
    players[socket.id] = {
      room: roomCode,
      name: playerName,
      isHost: false
    };

    socket.join(roomCode);
    io.to(roomCode).emit('playerJoined', rooms[roomCode].players);
    callback({ success: true, players: rooms[roomCode].players });
  });

  socket.on('startGame', (settings) => {
    const player = players[socket.id];
    if (!player || !player.isHost) return;

    const roomCode = player.room;
    const room = rooms[roomCode];
    if (!room || room.state !== 'lobby') return;

    room.state = 'playing';
    room.settings = settings;
    room.gameState = {
      rounds: settings.rounds,
      currentRound: 1,
      roundTime: settings.roundTime,
      difficulty: settings.difficulty,
      scores: {},
      playersWhoGuessed: [],
      allPlayers: room.players.map(p => p.id)
    };

    startRound(roomCode);
  });

  const startRound = (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;

    const previousDrawer = room.gameState?.currentDrawer;
    const eligiblePlayers = room.players.filter(p => p.id !== previousDrawer);
    const drawer = eligiblePlayers[Math.floor(Math.random() * eligiblePlayers.length)];

    room.gameState.currentDrawer = drawer.id;
    room.gameState.currentDrawerName = drawer.name;
    room.gameState.word = getRandomWord(room.gameState.difficulty);
    room.gameState.playersWhoGuessed = [];
    room.gameState.drawing = null;

    room.gameState.timer = room.gameState.roundTime;
    room.timerInterval = setInterval(() => {
      room.gameState.timer--;

      const hint = calculateHint(
        room.gameState.word,
        room.gameState.roundTime - room.gameState.timer,
        room.gameState.roundTime
      );
      if (hint) io.to(roomCode).emit('hint', hint);
      io.to(roomCode).emit('timerUpdate', room.gameState.timer);

      if (room.gameState.timer <= 0) {
        clearInterval(room.timerInterval);
        endRound(roomCode);
      }
    }, 1000);

    io.to(roomCode).emit('gameStarted', room.gameState);
  };

  const endRound = (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;

    clearInterval(room.timerInterval);

    if (room.gameState.currentRound >= room.gameState.rounds) {
      endGame(roomCode);
    } else {
      room.gameState.currentRound++;
      setTimeout(() => startRound(roomCode), 3000);
    }
  };

  const endGame = (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.state = 'ended';
    io.to(roomCode).emit('gameEnded', room.gameState.scores);
  };

  socket.on('drawing', (data) => {
    const player = players[socket.id];
    if (!player) return;

    const roomCode = player.room;
    const room = rooms[roomCode];
    if (!room || room.state !== 'playing') return;

    if (socket.id !== room.gameState.currentDrawer) return;

    room.gameState.drawing = data;
    socket.to(roomCode).emit('drawing', data);
  });

  socket.on('guess', (guess) => {
    const player = players[socket.id];
    if (!player) return;

    const roomCode = player.room;
    const room = rooms[roomCode];
    if (!room || room.state !== 'playing') return;

    if (socket.id === room.gameState.currentDrawer) return;
    if (room.gameState.playersWhoGuessed.includes(socket.id)) return;

    if (guess.toLowerCase() === room.gameState.word.toLowerCase()) {
      const timeLeft = room.gameState.timer;
      const maxScore = 100;
      const score = Math.floor(maxScore * (timeLeft / room.gameState.roundTime));

      room.gameState.scores[socket.id] = (room.gameState.scores[socket.id] || 0) + score;
      room.gameState.playersWhoGuessed.push(socket.id);

      const drawerScore = Math.floor(score * 0.5);
      room.gameState.scores[room.gameState.currentDrawer] =
        (room.gameState.scores[room.gameState.currentDrawer] || 0) + drawerScore;

      io.to(roomCode).emit('correctGuess', { player: player.name, guess });

      const allGuessed = room.gameState.allPlayers.every(id =>
        id === room.gameState.currentDrawer ||
        room.gameState.playersWhoGuessed.includes(id)
      );

      if (allGuessed) {
        clearInterval(room.timerInterval);
        setTimeout(() => endRound(roomCode), 2000);
      }
    } else {
      io.to(roomCode).emit('message', { player: player.name, text: guess });
    }
  });

  socket.on('playAgain', () => {
    const player = players[socket.id];
    if (!player || !player.isHost) return;

    const roomCode = player.room;
    const room = rooms[roomCode];
    if (!room || room.state !== 'ended') return;

    room.state = 'lobby';
    room.gameState = null;
    io.to(roomCode).emit('playerJoined', room.players);
  });

  socket.on('disconnect', () => {
    const player = players[socket.id];
    if (!player) return;

    const roomCode = player.room;
    if (!rooms[roomCode]) return;

    rooms[roomCode].players = rooms[roomCode].players.filter(p => p.id !== socket.id);
    delete players[socket.id];

    if (rooms[roomCode].players.length === 0) {
      delete rooms[roomCode];
    } else {
      io.to(roomCode).emit('playerJoined', rooms[roomCode].players);

      if (socket.id === rooms[roomCode].host) {
        const newHost = rooms[roomCode].players[0];
        rooms[roomCode].host = newHost.id;
        players[newHost.id].isHost = true;
        io.to(roomCode).emit('newHost', newHost.id);
      }

      if (rooms[roomCode].state === 'playing' &&
          socket.id === rooms[roomCode].gameState.currentDrawer) {
        clearInterval(rooms[roomCode].timerInterval);
        endRound(roomCode);
      }
    }
  });
});

// Static serving for frontend build (optional)
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/dist/index.html'));
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
