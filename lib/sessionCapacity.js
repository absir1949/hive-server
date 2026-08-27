function maxRunningBrowsers() {
  const parsed = parseInt(process.env.MAX_RUNNING_BROWSERS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8;
}

function idleStopMs() {
  const parsed = parseInt(process.env.IDLE_STOP_MS, 10);
  if (process.env.IDLE_STOP_MS === '0') return 0;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10 * 60 * 1000;
}

/**
 * Choose a running browser to stop so a new one can start.
 * Protected ids (VNC lease or open collection pages) are never chosen.
 */
function pickEvictionVictim({
  runningIds,
  maxRunning,
  startingId,
  protectedIds = new Set(),
  lastUsedAt = new Map(),
} = {}) {
  const running = (runningIds || []).map(String);
  const max = maxRunning || maxRunningBrowsers();
  const adding = startingId != null && !running.includes(String(startingId));
  const over = adding ? running.length >= max : running.length > max;
  if (!over) return null;

  let victim = null;
  let oldest = Infinity;
  for (const id of running) {
    if (id === String(startingId)) continue;
    if (protectedIds.has(id)) continue;
    const used = lastUsedAt.has(id) ? lastUsedAt.get(id) : 0;
    if (used < oldest) {
      oldest = used;
      victim = id;
    }
  }
  return victim;
}

module.exports = { maxRunningBrowsers, idleStopMs, pickEvictionVictim };
