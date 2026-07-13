'use strict';

const axios = require('axios');
const { parseManifest, pickBestVariant } = require('./m3u8');

const MANIFEST_TIMEOUT_MS = parseInt(process.env.MANIFEST_TIMEOUT_MS || '8000', 10);
const SEGMENT_TIMEOUT_MS = parseInt(process.env.SEGMENT_TIMEOUT_MS || '10000', 10);
const SEGMENT_SAMPLE_COUNT = parseInt(process.env.SEGMENT_SAMPLE_COUNT || '2', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '1', 10);

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

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
  const latencyMs = Date.now() - started;
  return { data: res.data, latencyMs, status: res.status };
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
  return { bytes, elapsedMs, status: res.status };
}

async function withRetries(fn, retries) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Runs a full health check on a single streamUrls[] entry.
 * Returns a plain object of fields to merge back into that entry in MongoDB.
 */
async function checkStream(entry) {
  const headers = buildHeaders(entry);
  const result = {
    lastCheckedAt: new Date(),
    healthScore: 0,
    status: 'dead',
    latencyMs: null,
    bufferHealthRatio: null,
    resolution: null,
    bandwidth: null,
    codecs: null,
    frameRate: null,
    audioTracks: [],
    isLive: null,
    segmentCount: null,
    targetDuration: null,
    drm: null,
    lastError: null,
  };

  // Note: entry.licenseKey / entry.licenseType (e.g. clearkey) are only needed to *decrypt and
  // play* a stream - checking reachability and throughput of an encrypted manifest/segments does
  // not require decryption, so DRM streams are health-checked the same way as clear streams.
  if (entry.licenseKey || entry.licenseType) {
    result.drm = { ...(result.drm || {}), hasLicenseKeyInDb: true, licenseType: entry.licenseType || null };
  }

  try {
    // 1. Fetch the top-level manifest.
    const manifestRes = await withRetries(
      () => fetchText(entry.url, headers, MANIFEST_TIMEOUT_MS),
      MAX_RETRIES
    );
    result.latencyMs = manifestRes.latencyMs;

    let manifest = parseManifest(manifestRes.data, entry.url);
    let mediaManifest = manifest;
    let mediaManifestUrl = entry.url;

    // 2. If this is a master playlist, drill into the best (highest bandwidth) variant.
    if (manifest.type === 'master') {
      const best = pickBestVariant(manifest.variants);
      if (!best) {
        throw new Error('Master playlist had no variant streams');
      }
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

      const variantRes = await withRetries(
        () => fetchText(best.url, headers, MANIFEST_TIMEOUT_MS),
        MAX_RETRIES
      );
      mediaManifest = parseManifest(variantRes.data, best.url);
      mediaManifestUrl = best.url;
    } else {
      // Media playlist served directly (no master) - still capture whatever audio tracks it declares.
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

    const manifestOk = true;

    // 3. Download a handful of real segments to measure actual throughput ("will it buffer?").
    let segmentOk = false;
    let bufferHealthRatio = null;

    const sampleSegments = mediaManifest.segments.slice(0, SEGMENT_SAMPLE_COUNT);
    if (sampleSegments.length > 0) {
      let totalBytes = 0;
      let totalElapsedMs = 0;
      let totalDurationSec = 0;
      let successCount = 0;

      for (const seg of sampleSegments) {
        try {
          const segRes = await withRetries(
            () => fetchBinary(seg.url, headers, SEGMENT_TIMEOUT_MS),
            MAX_RETRIES
          );
          totalBytes += segRes.bytes;
          totalElapsedMs += segRes.elapsedMs;
          totalDurationSec += seg.duration || 0;
          successCount += 1;
        } catch (segErr) {
          // One failed segment doesn't necessarily kill the whole stream - keep trying the rest.
        }
      }

      segmentOk = successCount > 0;

      if (segmentOk && totalElapsedMs > 0) {
        const downloadSpeedBitsPerSec = (totalBytes * 8) / (totalElapsedMs / 1000);
        // Prefer the *measured* encoded bitrate (bytes/duration of the segments themselves),
        // since it reflects reality better than a possibly-stale declared BANDWIDTH value.
        let requiredBitrate = null;
        if (totalDurationSec > 0) {
          requiredBitrate = (totalBytes * 8) / totalDurationSec;
        } else if (result.bandwidth) {
          requiredBitrate = result.bandwidth;
        }
        if (requiredBitrate && requiredBitrate > 0) {
          bufferHealthRatio = downloadSpeedBitsPerSec / requiredBitrate;
        }
      }
    }

    result.bufferHealthRatio = bufferHealthRatio;

    const { scoreStream, statusFromScore } = require('./scorer');
    result.healthScore = scoreStream({
      manifestOk,
      segmentOk,
      bufferHealthRatio,
      latencyMs: result.latencyMs,
    });
    result.status = statusFromScore(result.healthScore);
  } catch (err) {
    result.lastError = err.message ? err.message.slice(0, 500) : String(err).slice(0, 500);
    result.healthScore = 0;
    result.status = 'dead';
  }

  return result;
}

module.exports = { checkStream };
