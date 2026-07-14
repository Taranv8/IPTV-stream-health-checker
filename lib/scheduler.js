'use strict';

const DEAD_BACKOFF_BASE_MS = parseInt(process.env.DEAD_BACKOFF_BASE_MS || '60000', 10); // 1 min
const DEAD_BACKOFF_MAX_MS = parseInt(process.env.DEAD_BACKOFF_MAX_MS || '3600000', 10); // 1 hr
const DEGRADED_CHECK_INTERVAL_MS = parseInt(process.env.DEGRADED_CHECK_INTERVAL_MS || '120000', 10); // 2 min
const ALIVE_CHECK_INTERVAL_MS = parseInt(process.env.ALIVE_CHECK_INTERVAL_MS || '0', 10); // 0 = every cycle

/**
 * Decides when a stream entry should next be checked.
 *  - dead streams back off exponentially (up to a cap) so we don't waste cycles hammering
 *    something that's been down for hours - but we still eventually re-check in case it recovers.
 *  - degraded/flaky streams get checked *more* often, since their ranking matters most while
 *    it's still being resolved.
 *  - healthy streams are checked on the normal cadence (every cycle, unless ALIVE_CHECK_INTERVAL_MS
 *    is set to something looser).
 */
function computeNextCheckAt(status, consecutiveFailures, now = new Date()) {
  let delayMs;
  if (status === 'dead') {
    const exp = Math.min(consecutiveFailures, 8);
    delayMs = Math.min(DEAD_BACKOFF_BASE_MS * 2 ** exp, DEAD_BACKOFF_MAX_MS);
  } else if (status === 'degraded') {
    delayMs = DEGRADED_CHECK_INTERVAL_MS;
  } else {
    delayMs = ALIVE_CHECK_INTERVAL_MS; // 0 -> always eligible next cycle
  }
  return new Date(now.getTime() + delayMs);
}

function isDue(entry, now = new Date()) {
  if (!entry.nextCheckAt) return true;
  const next = entry.nextCheckAt instanceof Date ? entry.nextCheckAt : new Date(entry.nextCheckAt);
  return next.getTime() <= now.getTime();
}

module.exports = { computeNextCheckAt, isDue };
