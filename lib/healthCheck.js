'use strict';

const axios = require('axios');
const { parseManifest: parseHls, pickBestVariant } = require('./m3u8');
const { parseManifest: parseDash } = require('./dash');
const { scoreStream, statusFromScore, qualityLabel } = require('./scorer');
const { computeNextCheckAt } = require('./scheduler');
const { sniffSegment } = require('./segmentSniff');

const MANIFEST_TIMEOUT_MS = parseInt(process.env.MANIFEST_TIMEOUT_MS || '8000', 10);
const SEGMENT_TIMEOUT_MS = parseInt(process.env.SEGMENT_TIMEOUT_MS || '10000', 10);
const SEGMENT_SAMPLE_COUNT = parseInt(process.env.SEGMENT_SAMPLE_COUNT || '2', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '2', 10);
const TEST_VARIANT_FALLBACK = process.env.TEST_VARIANT_FALLBACK !== 'false'; // default on - cheap HEAD checks
const KEY_URI_CHECK = process.env.KEY_URI_CHECK !== 'false'; // default on

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// HTTP statuses that mean "retrying won't help" - don't burn retry budget on these.
const PERMANENT_STATUS_CODES = new Set([400, 401, 403, 404, 405, 410]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err) {
  const status = err.response && err.response.status;
  if (status && PERMANENT_STATUS_CODES.has(status)) return false;
  return true;
}

async function withRetries(fn, retries) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === retries) break;
      // Exponential backoff with jitter, so a wobbly CDN gets breathing room instead of a hammering.
      const backoffMs = 400 * 2 ** attempt + Math.floor(Math.random() * 250);
      await sleep(backoffMs);
    }
  }
  throw lastErr;
}

/** Builds request headers for a given streamUrls[] entry, respecting its stored userAgent/httpHeaders. */
function buildHeaders(entry) {
  const headers = {
    'User-Agent': entry.userAgent || DEFAULT_USER_AGENT,
    Accept: '*/*',
  };
  if (entry.httpHeaders && typeof entry.httpHeaders === 'object') {
    for (const [key, value] of Object.entries(entry.httpHeaders)) {
      if (value) headers[key] = value;
    }
  }
  return headers;
}

async function fetchText(url, headers, timeoutMs) {
  const started = Date.now();
  const res = await axios.get(url, {
    headers,
    timeout: timeoutMs,
    responseType: 'text',
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
  });
  return { data: res.data, latencyMs: Date.now() - started, status: res.status, contentType: res.headers['content-type'] || '' };
}

async function fetchBinary(url, headers, timeoutMs) {
  const started = Date.now();
  const res = await axios.get(url, {
    headers,
    timeout: timeoutMs,
    responseType: 'arraybuffer',
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
  });
  const elapsedMs = Date.now() - started;
  const bytes = res.data ? res.data.byteLength : 0;
  return { bytes, elapsedMs, status: res.status, data: res.data };
}

/** Cheap reachability probe - HEAD first, falls back to a 1-byte ranged GET for CDNs that reject HEAD. */
async function headOrRangedGet(url, headers, timeoutMs) {
  try {
    await axios.head(url, { headers, timeout: timeoutMs, maxRedirects: 5, validateStatus: (s) => s >= 200 && s < 400 });
    return true;
  } catch (e) {
    try {
      await axios.get(url, {
        headers: { ...headers, Range: 'bytes=0-0' },
        timeout: timeoutMs,
        maxRedirects: 5,
        validateStatus: (s) => s >= 200 && s < 400,
      });
      return true;
    } catch (e2) {
      return false;
    }
  }
}

function detectManifestFormat(text, url, contentType) {
  const head = text.trim().slice(0, 300);
  if (head.startsWith('#EXTM3U')) return 'hls';
  if (/^<\?xml/.test(head) || /<MPD[\s>]/.test(head)) return 'dash';
  if (contentType && contentType.includes('dash+xml')) return 'dash';
  if (contentType && (contentType.includes('mpegurl') || contentType.includes('vnd.apple'))) return 'hls';
  if (/\.mpd(\?|$)/i.test(url)) return 'dash';
  return 'hls'; // sensible default - most IPTV sources are HLS
}

/**
 * Compares a "freeze token" (media sequence, last segment URL, or DASH segment number) against
 * what we saw last check. If a *live* manifest's token hasn't moved after enough time has passed
 * for at least one segment to elapse, the source is serving a stale/zombie manifest - it looks
 * reachable but isn't actually live. Returns true/false, or null when we can't judge yet
 * (VOD content, first-ever check, or not enough elapsed time).
 */
function computeFreeze(isLive, freezeToken, entry) {
  if (!isLive || !freezeToken) return null;
  const prevToken = entry.freezeToken;
  const prevCheckedAt = entry.lastCheckedAt ? new Date(entry.lastCheckedAt).getTime() : null;
  if (!prevToken || !prevCheckedAt) return null;
  const elapsedSec = (Date.now() - prevCheckedAt) / 1000;
  const minExpectedAdvanceSec = entry.targetDuration || 6;
  if (elapsedSec < minExpectedAdvanceSec) return null;
  return prevToken === freezeToken;
}

/**
 * Downloads sample segments, measuring aggregate throughput and per-segment jitter.
 * Each segment's actual bytes are sniffed (see lib/segmentSniff.js) rather than just trusting
 * a 200 OK - a very common failure mode is a CDN/token-expiry page served with a success status,
 * which looks "reachable" but is not playable media. Those don't count as a successful segment.
 */
async function sampleSegmentsThroughput(sampleSegments, headers, declaredBandwidth) {
  if (!sampleSegments || sampleSegments.length === 0) {
    return { segmentOk: false, bufferHealthRatio: null, jitterRatio: null, segmentFormat: null, invalidSegmentReason: null };
  }

  const perSegmentSpeedBps = [];
  let totalBytes = 0;
  let totalElapsedMs = 0;
  let totalDurationSec = 0;
  let successCount = 0;
  let segmentFormat = null;
  let invalidSegmentReason = null;

  for (const seg of sampleSegments) {
    try {
      const segRes = await withRetries(() => fetchBinary(seg.url, headers, SEGMENT_TIMEOUT_MS), MAX_RETRIES);
      const sniff = sniffSegment(segRes.data);
      if (!sniff.valid) {
        invalidSegmentReason = invalidSegmentReason || sniff.reason;
        continue; // downloaded fine over HTTP, but it isn't actual media - don't count as success
      }
      segmentFormat = segmentFormat || sniff.format;
      totalBytes += segRes.bytes;
      totalElapsedMs += segRes.elapsedMs;
      totalDurationSec += seg.duration || 0;
      successCount += 1;
      if (segRes.elapsedMs > 0) {
        perSegmentSpeedBps.push((segRes.bytes * 8) / (segRes.elapsedMs / 1000));
      }
    } catch (segErr) {
      // One failed segment doesn't necessarily kill the whole stream - keep trying the rest.
    }
  }

  const segmentOk = successCount > 0;
  let bufferHealthRatio = null;
  if (segmentOk && totalElapsedMs > 0) {
    const downloadSpeedBps = (totalBytes * 8) / (totalElapsedMs / 1000);
    let requiredBitrate = null;
    if (totalDurationSec > 0) requiredBitrate = (totalBytes * 8) / totalDurationSec;
    else if (declaredBandwidth) requiredBitrate = declaredBandwidth;
    if (requiredBitrate && requiredBitrate > 0) bufferHealthRatio = downloadSpeedBps / requiredBitrate;
  }

  let jitterRatio = null;
  if (perSegmentSpeedBps.length >= 2) {
    const mean = perSegmentSpeedBps.reduce((a, b) => a + b, 0) / perSegmentSpeedBps.length;
    const variance = perSegmentSpeedBps.reduce((a, b) => a + (b - mean) ** 2, 0) / perSegmentSpeedBps.length;
    const stdDev = Math.sqrt(variance);
    jitterRatio = mean > 0 ? Math.min(1, stdDev / mean) : null;
  }

  return { segmentOk, bufferHealthRatio, jitterRatio, segmentFormat, invalidSegmentReason };
}

async function checkHlsStream(manifestText, manifestUrl, headers, entry, result, metrics) {
  const manifest = parseHls(manifestText, manifestUrl);
  let mediaManifest = manifest;
  let mediaManifestUrl = manifestUrl;

  if (manifest.type === 'master') {
    const best = pickBestVariant(manifest.variants);
    if (!best) throw new Error('Master playlist had no variant streams');

    result.resolution = best.resolution;
    result.bandwidth = best.bandwidth;
    result.codecs = best.codecs;
    result.frameRate = best.frameRate;
    result.audioTracks = manifest.audioTracks.map((t) => ({
      name: t.name,
      language: t.language,
      groupId: t.groupId,
      isDefault: t.isDefault,
    }));

    const variantRes = await withRetries(() => fetchText(best.url, headers, MANIFEST_TIMEOUT_MS), MAX_RETRIES);
    mediaManifest = parseHls(variantRes.data, best.url);
    mediaManifestUrl = best.url;

    // Cheap, informational check: do the *other* quality variants also resolve? Tells the app
    // whether adaptive-bitrate fallback will actually work if a viewer's connection is poor.
    if (TEST_VARIANT_FALLBACK && manifest.variants.length > 1) {
      const others = manifest.variants.filter((v) => v.url !== best.url);
      const otherChecks = await Promise.all(
        others.map(async (v) => ({
          resolution: v.resolution,
          bandwidth: v.bandwidth,
          reachable: await headOrRangedGet(v.url, headers, MANIFEST_TIMEOUT_MS),
        }))
      );
      result.variantHealth = [
        { resolution: best.resolution, bandwidth: best.bandwidth, reachable: true },
        ...otherChecks,
      ];
    }
  } else {
    result.audioTracks = manifest.audioTracks.map((t) => ({
      name: t.name,
      language: t.language,
      groupId: t.groupId,
      isDefault: t.isDefault,
    }));
  }

  result.isLive = mediaManifest.isLive;
  result.targetDuration = mediaManifest.targetDuration;
  result.segmentCount = mediaManifest.segments.length;
  if (mediaManifest.drm) {
    result.drm = { ...(result.drm || {}), ...mediaManifest.drm };
  }

  const lastSeg = mediaManifest.segments[mediaManifest.segments.length - 1];
  const freezeToken =
    mediaManifest.mediaSequence != null ? `seq:${mediaManifest.mediaSequence}` : lastSeg ? `seg:${lastSeg.url}` : null;
  result.freezeToken = freezeToken;
  metrics.isFrozen = computeFreeze(mediaManifest.isLive, freezeToken, entry);

  const sampleSegments = mediaManifest.segments.slice(0, SEGMENT_SAMPLE_COUNT);
  const { segmentOk, bufferHealthRatio, jitterRatio, segmentFormat, invalidSegmentReason } = await sampleSegmentsThroughput(
    sampleSegments,
    headers,
    result.bandwidth
  );
  metrics.segmentOk = segmentOk;
  metrics.bufferHealthRatio = bufferHealthRatio;
  metrics.jitterRatio = jitterRatio;
  result.bufferHealthRatio = bufferHealthRatio;
  result.jitterRatio = jitterRatio;
  result.segmentFormat = segmentFormat;
  result.invalidSegmentReason = invalidSegmentReason;

  // If the key is delivered via URI (AES-128 / SAMPLE-AES), confirm that URI actually resolves -
  // segments can download fine and still be unplayable if the key delivery endpoint is dead.
  if (KEY_URI_CHECK && mediaManifest.drm && mediaManifest.drm.uri) {
    const keyUrl = /^https?:\/\//i.test(mediaManifest.drm.uri)
      ? mediaManifest.drm.uri
      : new URL(mediaManifest.drm.uri, mediaManifestUrl).toString();
    metrics.keyUriReachable = await headOrRangedGet(keyUrl, headers, MANIFEST_TIMEOUT_MS);
    result.keyUriReachable = metrics.keyUriReachable;
  }
}

async function checkDashStream(manifestText, manifestUrl, headers, entry, result, metrics) {
  const manifest = parseDash(manifestText, manifestUrl);

  result.isLive = manifest.isLive;
  if (manifest.variants.length) {
    const best = manifest.variants.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
    result.resolution = best.resolution;
    result.bandwidth = best.bandwidth;
    result.codecs = best.codecs;
    result.frameRate = best.frameRate;
  }
  result.audioTracks = manifest.audioTracks;
  if (manifest.drm) result.drm = { ...(result.drm || {}), ...manifest.drm };

  result.freezeToken = manifest.freezeToken;
  metrics.isFrozen = computeFreeze(manifest.isLive, manifest.freezeToken, entry);

  if (manifest.segmentProbe) {
    const seg = { url: manifest.segmentProbe.url, duration: manifest.segmentProbe.durationSec || null };
    const { segmentOk, bufferHealthRatio, jitterRatio, segmentFormat, invalidSegmentReason } = await sampleSegmentsThroughput(
      [seg],
      headers,
      result.bandwidth
    );
    metrics.segmentOk = segmentOk;
    metrics.bufferHealthRatio = bufferHealthRatio;
    metrics.jitterRatio = jitterRatio;
    result.bufferHealthRatio = bufferHealthRatio;
    result.jitterRatio = jitterRatio;
    result.segmentFormat = segmentFormat;
    result.invalidSegmentReason = invalidSegmentReason;
  } else {
    metrics.segmentOk = false;
  }

  // DASH ClearKey/DRM keys are almost always supplied out-of-band (same as this DB's own
  // licenseKey field), not fetched from a URI in the manifest - so we only have something to
  // verify when the manifest explicitly declares a license-acquisition URL (dashif:Laurl).
  if (KEY_URI_CHECK && manifest.drm && manifest.drm.laUrl) {
    metrics.keyUriReachable = await headOrRangedGet(manifest.drm.laUrl, headers, MANIFEST_TIMEOUT_MS);
    result.keyUriReachable = metrics.keyUriReachable;
  }
}

/**
 * Runs a full health check on a single streamUrls[] entry.
 * `entry` is the full current DB sub-document, including whatever fields a previous check
 * persisted (healthScore, consecutiveFailures, scoreHistory, freezeToken, lastCheckedAt,
 * targetDuration...) - this is what lets scoring be smoothed and freeze-detection work
 * across checks instead of being blind on every run.
 * Returns a plain object of fields to merge back into that entry in MongoDB.
 */
async function checkStream(entry) {
  const headers = buildHeaders(entry);
  const result = {
    lastCheckedAt: new Date(),
    manifestFormat: null,
    latencyMs: null,
    resolution: null,
    qualityLabel: null,
    bandwidth: null,
    codecs: null,
    frameRate: null,
    audioTracks: [],
    isLive: null,
    segmentCount: null,
    targetDuration: null,
    drm: null,
    bufferHealthRatio: null,
    jitterRatio: null,
    isFrozen: null,
    keyUriReachable: null,
    variantHealth: null,
    freezeToken: null,
    segmentFormat: null,
    invalidSegmentReason: null,
    lastError: null,
  };

  // Decrypting/playing a DRM stream needs licenseKey; *measuring reachability and throughput*
  // does not, since we're only downloading bytes - so DRM streams are checked the same way as
  // clear ones. We just note that a license is on file for the app's own reference.
  if (entry.licenseKey || entry.licenseType) {
    result.drm = { hasLicenseKeyInDb: true, licenseType: entry.licenseType || null };
  }

  const metrics = {
    manifestOk: false,
    segmentOk: false,
    bufferHealthRatio: null,
    latencyMs: null,
    jitterRatio: null,
    isFrozen: null,
    keyUriReachable: null,
  };

  try {
    const manifestRes = await withRetries(() => fetchText(entry.url, headers, MANIFEST_TIMEOUT_MS), MAX_RETRIES);
    result.latencyMs = manifestRes.latencyMs;
    metrics.latencyMs = manifestRes.latencyMs;

    const format = detectManifestFormat(manifestRes.data, entry.url, manifestRes.contentType);
    result.manifestFormat = format;

    if (format === 'dash') {
      await checkDashStream(manifestRes.data, entry.url, headers, entry, result, metrics);
    } else {
      await checkHlsStream(manifestRes.data, entry.url, headers, entry, result, metrics);
    }

    metrics.manifestOk = true;
    result.qualityLabel = qualityLabel(result.resolution);

    const scored = scoreStream(metrics, entry);
    Object.assign(result, scored);
    result.status = statusFromScore(result.healthScore);
  } catch (err) {
    result.lastError = err.message ? err.message.slice(0, 500) : String(err).slice(0, 500);
    const scored = scoreStream({ manifestOk: false }, entry);
    Object.assign(result, scored);
    result.status = statusFromScore(result.healthScore);
  }

  result.nextCheckAt = computeNextCheckAt(result.status, result.consecutiveFailures, result.lastCheckedAt);

  return result;
}

module.exports = { checkStream };
