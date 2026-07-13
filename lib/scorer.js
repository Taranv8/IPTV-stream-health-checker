'use strict';

/**
 * Turns raw health-check metrics into a single 0-100 score.
 *
 * Weighting (sums to 100):
 *   - Manifest reachable & parseable:        30 pts
 *   - Segment(s) actually downloadable:       25 pts
 *   - Buffer health (download speed vs the    30 pts
 *     bitrate needed to play in real time)
 *   - Latency (lower is better):              15 pts
 *
 * A dead / unreachable stream scores 0.
 */
function scoreStream(metrics) {
  const {
    manifestOk,
    segmentOk,
    bufferHealthRatio, // downloadSpeedBits / requiredBitrate. >=1 means it downloads at least as fast as it plays.
    latencyMs,
  } = metrics;

  if (!manifestOk) return 0;

  let score = 30; // manifest reachable

  if (segmentOk) {
    score += 25;
  }

  // Buffer health: ratio >= 2 (downloads twice as fast as needed) is "perfect".
  // ratio < 1 means it can't keep up and will stall/buffer during playback.
  if (typeof bufferHealthRatio === 'number' && isFinite(bufferHealthRatio)) {
    const clamped = Math.max(0, Math.min(bufferHealthRatio / 2, 1)); // 0..1
    score += Math.round(clamped * 30);
  }

  // Latency scoring: <=300ms full marks, scaling down to 0 at >=3000ms.
  if (typeof latencyMs === 'number' && isFinite(latencyMs)) {
    const latencyScore = Math.max(0, Math.min(1, (3000 - latencyMs) / (3000 - 300)));
    score += Math.round(latencyScore * 15);
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function statusFromScore(score) {
  if (score === 0) return 'dead';
  if (score < 50) return 'degraded';
  return 'alive';
}

module.exports = { scoreStream, statusFromScore };
