const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { 
  getRandomWord, 
  maskWord, 
  isWordLocked,
  releaseWord
} = require('./game/wordManager');
const { 
  checkCooldown, 
  resetSpamCounter 
} = require('./game/antiCheat');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  connectionStateRecovery: {
    maxDisconnectionDuration: 120000 // 2 minutes
  }
});

// Game state
const rooms = {};
const players = {};
const playerAvatars = {};

// Helper functions
const calculateHint = (word, timeElapsed, roundTime) => {
  const progress = timeElapsed / roundTime;
  if (progress < 0.3) return '';
  if (progress < 0.6) return `It has ${word.length} letters`;
  if (progress < 0.8) return `Starts with: ${word[0]}`;
  return `Starts with: ${word[0]}...${word[word.length - 1]}`;
};

const calculateScore = (timeLeft, roundTime) => {
  const maxScore = 100;
  return Math.floor(maxScore * (timeLeft / roundTime));
};

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  // Player Management
  socket.on('createRoom', (playerName, avatar, callback) => {
    const roomCode = generateRoomCode();
    const player = { 
      id: socket.id, 
      name: playerName, 
      isHost: true,
      avatar
    };

    rooms[roomCode] = {
      players: [player],
      host: socket.id,
      state: 'lobby',
      settings: {}
    };

    players[socket.id] = {
      room: roomCode,
      name: playerName,
      isHost: true,
      avatar
    };

    playerAvatars[socket.id] = avatar;

    socket.join(roomCode);
    callback({ roomCode });
    io.to(roomCode).emit('playerUpdate', rooms[roomCode].players);
  });

  socket.on('joinRoom', (roomCode, playerName, avatar, callback) => {
    if (!rooms[roomCode]) return callback({ error: 'Room not found' });
    if (rooms[roomCode].state !== 'lobby') return callback({ error: 'Game already started' });
    if (rooms[roomCode].players.length >= 8) return callback({ error: 'Room is full' });

    const player = { 
      id: socket.id, 
      name: playerName, 
      isHost: false,
      avatar
    };

    rooms[roomCode].players.push(player);
    players[socket.id] = {
      room: roomCode,
      name: playerName,
      isHost: false,
      avatar
    };

    playerAvatars[socket.id] = avatar;

    socket.join(roomCode);
    io.to(roomCode).emit('playerUpdate', rooms[roomCode].players);
    callback({ success: true, players: rooms[roomCode].players });
  });

  socket.on('updateAvatar', (avatar) => {
    if (!players[socket.id]) return;
    
    playerAvatars[socket.id] = avatar;
    players[socket.id].avatar = avatar;
    
    const roomCode = players[socket.id].room;
    if (rooms[roomCode]) {
      const playerIndex = rooms[roomCode].players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        rooms[roomCode].players[playerIndex].avatar = avatar;
        io.to(roomCode).emit('playerUpdate', rooms[roomCode].players);
      }
    }
  });

  // Game Management
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
      allPlayers: room.players.map(p => p.id),
      avatars: room.players.reduce((acc, p) => {
        acc[p.id] = p.avatar;
        return acc;
      }, {})
    };

    startRound(roomCode);
  });

  const startRound = (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;

    // Select random drawer (excluding previous drawer if any)
    const previousDrawer = room.gameState?.currentDrawer;
    const eligiblePlayers = room.players.filter(p => p.id !== previousDrawer);
    const drawer = eligiblePlayers[Math.floor(Math.random() * eligiblePlayers.length)];

    // Setup round state
    room.gameState.currentDrawer = drawer.id;
    room.gameState.currentDrawerName = drawer.name;
    room.gameState.currentDrawerAvatar = drawer.avatar;
    room.gameState.word = getRandomWord(room.gameState.difficulty);
    room.gameState.playersWhoGuessed = [];
    room.gameState.drawing = null;
    room.gameState.timer = room.gameState.roundTime;
    room.gameState.hint = '';

    // Start timer
    room.timerInterval = setInterval(() => {
      room.gameState.timer--;

      // Update hint
      const newHint = calculateHint(
        room.gameState.word,
        room.gameState.roundTime - room.gameState.timer,
        room.gameState.roundTime
      );
      
      if (newHint !== room.gameState.hint) {
        room.gameState.hint = newHint;
        io.to(roomCode).emit('hint', newHint);
      }

      io.to(roomCode).emit('timerUpdate', room.gameState.timer);

      // End round when time expires
      if (room.gameState.timer <= 0) {
        clearInterval(room.timerInterval);
        endRound(roomCode);
      }
    }, 1000);

    io.to(roomCode).emit('roundStarted', {
      drawer: drawer.id,
      drawerName: drawer.name,
      drawerAvatar: drawer.avatar,
      round: room.gameState.currentRound,
      totalRounds: room.gameState.rounds,
      timer: room.gameState.roundTime
    });

    // Send word only to drawer
    io.to(drawer.id).emit('wordUpdate', room.gameState.word);
  };

  const endRound = (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;

    clearInterval(room.timerInterval);
    releaseWord(room.gameState.word);

    // Check if game should end
    if (room.gameState.currentRound >= room.gameState.rounds) {
      endGame(roomCode);
    } else {
      room.gameState.currentRound++;
      io.to(roomCode).emit('roundEnded', {
        scores: room.gameState.scores,
        nextRoundIn: 3000
      });
      
      setTimeout(() => startRound(roomCode), 3000);
    }
  };

  const endGame = (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.state = 'ended';
    io.to(roomCode).emit('gameEnded', {
      scores: room.gameState.scores,
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        score: room.gameState.scores[p.id] || 0
      }))
    });
  };

  // Gameplay Events
  socket.on('drawing', (data) => {
    const player = players[socket.id];
    if (!player) return;

    const roomCode = player.room;
    const room = rooms[roomCode];
    if (!room || room.state !== 'playing') return;

    // Only drawer can send drawing data
    if (socket.id !== room.gameState.currentDrawer) return;

    room.gameState.drawing = data;
    socket.to(roomCode).emit('drawing', data);
  });

  socket.on('clearCanvas', () => {
    const player = players[socket.id];
    if (!player) return;

    const roomCode = player.room;
    const room = rooms[roomCode];
    if (!room || room.state !== 'playing') return;

    if (socket.id !== room.gameState.currentDrawer) return;

    io.to(roomCode).emit('clearCanvas');
  });

  socket.on('submitGuess', (guess) => {
    const player = players[socket.id];
    if (!player) return;

    // Anti-cheat checks
    const cooldownCheck = checkCooldown(socket.id, 'guess');
    if (!cooldownCheck.allowed) return;

    const roomCode = player.room;
    const room = rooms[roomCode];
    if (!room || room.state !== 'playing') return;

    // Drawer can't guess
    if (socket.id === room.gameState.currentDrawer) return;

    // Prevent duplicate correct guesses
    if (room.gameState.playersWhoGuessed.includes(socket.id)) return;

    const guessLower = guess.toLowerCase();
    const wordLower = room.gameState.word.toLowerCase();

    if (guessLower === wordLower) {
      // Calculate score
      const score = calculateScore(room.gameState.timer, room.gameState.roundTime);
      room.gameState.scores[socket.id] = (room.gameState.scores[socket.id] || 0) + score;
      
      // Give drawer partial points
      const drawerScore = Math.floor(score * 0.5);
      room.gameState.scores[room.gameState.currentDrawer] = 
        (room.gameState.scores[room.gameState.currentDrawer] || 0) + drawerScore;

      room.gameState.playersWhoGuessed.push(socket.id);

      // Send masked version to other players if >2 players
      const maskedGuess = room.players.length > 2 ? 
        maskWord(room.gameState.word) : 
        room.gameState.word;

      io.to(socket.id).emit('correctGuess', {
        player: player.name,
        guess: room.gameState.word,
        isYou: true,
        score
      });

      socket.to(roomCode).emit('correctGuess', {
        player: player.name,
        guess: maskedGuess,
        isYou: false,
        score
      });

      // Check if all players guessed correctly
      const allGuessed = room.gameState.allPlayers.every(id => 
        id === room.gameState.currentDrawer || 
        room.gameState.playersWhoGuessed.includes(id)
      );

      if (allGuessed) {
        clearInterval(room.timerInterval);
        setTimeout(() => endRound(roomCode), 2000);
      }
    } else {
      // Incorrect guess
      io.to(roomCode).emit('gameMessage', {
        type: 'guess',
        player: player.name,
        playerId: socket.id,
        text: guess,
        correct: false,
        timestamp: Date.now()
      });
    }
  });

  socket.on('sendChatMessage', (message) => {
    const player = players[socket.id];
    if (!player) return;

    // Anti-spam checks
    const cooldownCheck = checkCooldown(socket.id, 'message');
    if (!cooldownCheck.allowed) return;

    const roomCode = player.room;
    io.to(roomCode).emit('chatMessage', {
      player: player.name,
      playerId: socket.id,
      avatar: player.avatar,
      text: message,
      timestamp: Date.now()
    });
  });

  socket.on('playAgain', () => {
    const player = players[socket.id];
    if (!player || !player.isHost) return;

    const roomCode = player.room;
    const room = rooms[roomCode];
    if (!room || room.state !== 'ended') return;

    room.state = 'lobby';
    room.gameState = null;
    io.to(roomCode).emit('lobbyRestarted', room.players);
  });

  socket.on('disconnect', () => {
    const player = players[socket.id];
    if (!player) return;

    const roomCode = player.room;
    if (!rooms[roomCode]) return;

    // Remove player
    rooms[roomCode].players = rooms[roomCode].players.filter(p => p.id !== socket.id);
    delete players[socket.id];
    delete playerAvatars[socket.id];
    resetSpamCounter(socket.id);

    if (rooms[roomCode].players.length === 0) {
      // Room empty - clean up
      delete rooms[roomCode];
    } else {
      // Update remaining players
      io.to(roomCode).emit('playerUpdate', rooms[roomCode].players);

      // Handle host transfer
      if (socket.id === rooms[roomCode].host) {
        const newHost = rooms[roomCode].players[0];
        rooms[roomCode].host = newHost.id;
        players[newHost.id].isHost = true;
        io.to(roomCode).emit('newHost', newHost.id);
      }

      // Handle drawer disconnection
      if (rooms[roomCode].state === 'playing' && 
          socket.id === rooms[roomCode].gameState?.currentDrawer) {
        clearInterval(rooms[roomCode].timerInterval);
        endRound(roomCode);
      }
    }
  });
});

// Helper function to generate room codes
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Serve frontend in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/dist/index.html'));
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});