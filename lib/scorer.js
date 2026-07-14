'use strict';

const EMA_ALPHA = parseFloat(process.env.EMA_ALPHA || '0.4');
const CONSECUTIVE_FAILURES_TO_CONFIRM_DEAD = parseInt(process.env.CONSECUTIVE_FAILURES_TO_CONFIRM_DEAD || '3', 10);

/**
 * Raw, single-check score out of 100. This is *before* smoothing across checks.
 *
 *   Manifest reachable & parseable                         20
 *   Segment(s) actually downloadable                       20
 *   Buffer health ratio (download speed vs required rate)  25
 *   Latency (lower is better)                               10
 *   Consistency across sampled segments (low jitter)        10   (N/A -> full marks)
 *   Not frozen (a "live" manifest is actually advancing)    10   (N/A for VOD -> full marks)
 *   DRM key/license delivery reachable                       5   (N/A if no key URI -> full marks)
 */
function rawScore(metrics) {
  const {
    manifestOk,
    segmentOk,
    bufferHealthRatio,
    latencyMs,
    jitterRatio,      // stddev/mean of per-segment throughput; lower = more consistent. null = N/A
    isFrozen,          // true/false/null (null = not applicable / not enough data)
    keyUriReachable,   // true/false/null (null = no key URI to check)
  } = metrics;

  if (!manifestOk) return 0;

  let score = 20; // manifest reachable

  if (segmentOk) score += 20;

  if (typeof bufferHealthRatio === 'number' && isFinite(bufferHealthRatio)) {
    const clamped = Math.max(0, Math.min(bufferHealthRatio / 2, 1));
    score += Math.round(clamped * 25);
  }

  if (typeof latencyMs === 'number' && isFinite(latencyMs)) {
    const latencyScore = Math.max(0, Math.min(1, (3000 - latencyMs) / (3000 - 300)));
    score += Math.round(latencyScore * 10);
  }

  if (jitterRatio === null || jitterRatio === undefined) {
    score += 10; // not enough samples to judge - don't penalize
  } else {
    const consistency = Math.max(0, Math.min(1, 1 - jitterRatio)); // jitterRatio 0 = perfectly steady
    score += Math.round(consistency * 10);
  }

  if (isFrozen === null || isFrozen === undefined) {
    score += 10; // VOD or first-ever check - can't judge freshness yet
  } else if (isFrozen === false) {
    score += 10;
  } // isFrozen === true -> 0 points, the manifest isn't actually moving

  if (keyUriReachable === null || keyUriReachable === undefined) {
    score += 5; // no key delivery URL to verify
  } else if (keyUriReachable === true) {
    score += 5;
  } // key URI present but unreachable -> playback will fail even though segments download fine

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Blends this check's raw score with prior history into a smoothed, "smart" score that:
 *  - doesn't collapse a normally-good stream over one bad blip (EMA smoothing)
 *  - DOES confirm a stream as dead (hard override to 0) after several consecutive total failures,
 *    rather than letting stale EMA memory keep a truly-dead link ranked highly
 *  - tracks a short rolling history for an informational "volatility" read-out
 *
 * @param {object} metrics this check's raw metrics (see rawScore)
 * @param {object} previous prior persisted state from the DB entry (may be empty on first check)
 */
function scoreStream(metrics, previous = {}) {
  const instant = rawScore(metrics);

  const prevEma = typeof previous.healthScore === 'number' ? previous.healthScore : null;
  const prevConsecutiveFailures = previous.consecutiveFailures || 0;
  const prevHistory = Array.isArray(previous.scoreHistory) ? previous.scoreHistory : [];

  const consecutiveFailures = instant === 0 ? prevConsecutiveFailures + 1 : 0;
  const consecutiveSuccesses = instant > 0 ? (previous.consecutiveSuccesses || 0) + 1 : 0;

  let ema = prevEma === null ? instant : Math.round(EMA_ALPHA * instant + (1 - EMA_ALPHA) * prevEma);

  // Confirmed-dead override: don't let smoothing keep a genuinely dead link near the top.
  if (consecutiveFailures >= CONSECUTIVE_FAILURES_TO_CONFIRM_DEAD) {
    ema = 0;
  }

  const scoreHistory = [...prevHistory, instant].slice(-10);
  const mean = scoreHistory.reduce((a, b) => a + b, 0) / scoreHistory.length;
  const variance = scoreHistory.reduce((a, b) => a + (b - mean) ** 2, 0) / scoreHistory.length;
  const volatility = scoreHistory.length > 1 ? Math.round(Math.sqrt(variance)) : 0;

  return {
    rawScore: instant,
    healthScore: ema,
    consecutiveFailures,
    consecutiveSuccesses,
    scoreHistory,
    volatility, // informational: how much this stream's score swings check-to-check
  };
}

function statusFromScore(score) {
  if (score === 0) return 'dead';
  if (score < 50) return 'degraded';
  return 'alive';
}

function qualityLabel(resolution) {
  if (!resolution) return null;
  const match = /x(\d+)$/.exec(resolution);
  const height = match ? parseInt(match[1], 10) : null;
  if (!height) return null;
  if (height >= 2160) return '4K';
  if (height >= 1440) return '2K/QHD';
  if (height >= 1080) return '1080p (Full HD)';
  if (height >= 720) return '720p (HD)';
  if (height >= 480) return '480p (SD)';
  return `${height}p (Low)`;
}

module.exports = { rawScore, scoreStream, statusFromScore, qualityLabel };
