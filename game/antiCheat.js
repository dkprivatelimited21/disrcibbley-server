const cooldowns = new Map();
const spamCounts = new Map();
const LAST_GUESS_TIMEOUT = 1000; // 1 second between guesses
const SPAM_LIMIT = 5; // Max messages in short period
const SPAM_WINDOW = 5000; // 5 second window

function checkCooldown(playerId, type = 'guess') {
  const now = Date.now();
  
  // Initialize if not exists
  if (!cooldowns.has(playerId)) {
    cooldowns.set(playerId, { guess: 0, message: 0 });
  }
  if (!spamCounts.has(playerId)) {
    spamCounts.set(playerId, { count: 0, lastReset: now });
  }

  // Check spam rate limiting
  if (now - spamCounts.get(playerId).lastReset > SPAM_WINDOW) {
    spamCounts.set(playerId, { count: 0, lastReset: now });
  } else if (spamCounts.get(playerId).count >= SPAM_LIMIT) {
    return { allowed: false, remaining: SPAM_WINDOW - (now - spamCounts.get(playerId).lastReset) };
  }

  // Check specific cooldown
  const playerCooldown = cooldowns.get(playerId);
  const remaining = playerCooldown[type] + LAST_GUESS_TIMEOUT - now;
  
  if (remaining > 0) {
    return { allowed: false, remaining };
  }

  // Update trackers
  playerCooldown[type] = now;
  spamCounts.get(playerId).count++;
  
  return { allowed: true };
}

function resetSpamCounter(playerId) {
  spamCounts.delete(playerId);
}

module.exports = { checkCooldown, resetSpamCounter };