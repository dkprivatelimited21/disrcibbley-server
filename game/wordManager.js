const wordLists = require('./words.json');
const activeWords = new Map();
const WORD_LOCK_TIME = 30000; // 30 seconds lock after correct guess

function getRandomWord(difficulty = 'easy') {
  const list = wordLists[difficulty] || wordLists.easy;
  const word = list[Math.floor(Math.random() * list.length)];
  activeWords.set(word.toLowerCase(), {
    timestamp: Date.now(),
    difficulty
  });
  return word;
}

function maskWord(word, revealPercentage = 0.3) {
  if (!word) return '';
  const chars = word.split('');
  const revealCount = Math.max(1, Math.floor(chars.length * revealPercentage));
  
  // Always reveal first letter
  const revealed = [0];
  
  // Reveal additional characters at random positions
  while (revealed.length < revealCount) {
    const pos = Math.floor(Math.random() * chars.length);
    if (!revealed.includes(pos)) revealed.push(pos);
  }

  return chars.map((c, i) => revealed.includes(i) ? c : '_').join(' ');
}

function isWordLocked(word) {
  const entry = activeWords.get(word.toLowerCase());
  if (!entry) return false;
  return (Date.now() - entry.timestamp) < WORD_LOCK_TIME;
}

function releaseWord(word) {
  activeWords.delete(word.toLowerCase());
}

module.exports = { 
  getRandomWord, 
  maskWord, 
  activeWords,
  isWordLocked,
  releaseWord
};