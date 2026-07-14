'use strict';

const { XMLParser } = require('fast-xml-parser');

/**
 * Minimal MPEG-DASH (.mpd) manifest parser.
 * DASH is how "clearkey" content is most commonly delivered (vs HLS), so this lets the
 * checker understand it natively instead of only handling HLS/m3u8.
 *
 * DASH has many optional profiles/layouts (SegmentTemplate vs SegmentList vs SegmentBase,
 * multi-period, etc). This covers the common SegmentTemplate (with $Number$ or a
 * SegmentTimeline) case, which is what the vast majority of live/VOD DASH-ClearKey streams
 * use. Exotic manifests may not be fully understood - see README.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) => ['Period', 'AdaptationSet', 'Representation', 'ContentProtection', 'S', 'BaseURL'].includes(name),
});

// Known DRM system UUIDs (urn:uuid:<uuid> in ContentProtection@schemeIdUri).
// Source: DASH-IF content protection identifier registry (dashif.org/identifiers/content_protection).
const DRM_SYSTEM_IDS = {
  'e2719d58-a985-b3c9-781a-b030af78d30e': 'ClearKey',
  '9a04f079-9840-4286-ab92-e65be0885f95': 'PlayReady',
  'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'Widevine',
  '94ce86fb-07ff-4f43-adb8-93d2fa968ca2': 'FairPlay',
  '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b': 'Common (CENC)',
};

function resolveUrl(base, relative) {
  if (!relative) return base;
  try {
    return new URL(relative, base).toString();
  } catch (e) {
    return relative;
  }
}

function toArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function parseContentProtections(rawList) {
  return toArray(rawList).map((cp) => {
    const schemeIdUri = cp['@_schemeIdUri'] || null;
    const uuidMatch = schemeIdUri && /urn:uuid:([0-9a-fA-F-]{36})/.exec(schemeIdUri);
    const uuid = uuidMatch ? uuidMatch[1].toLowerCase() : null;
    return {
      schemeIdUri,
      value: cp['@_value'] || null,
      defaultKeyId: cp['@_cenc:default_KID'] || cp['@_default_KID'] || null,
      drmSystem: uuid ? DRM_SYSTEM_IDS[uuid] || 'Unknown DRM system' : schemeIdUri === 'urn:mpeg:dash:mp4protection:2011' ? 'Generic CENC' : null,
      laUrl: cp['dashif:Laurl'] || cp['clearkey:Laurl'] || null,
    };
  });
}

/** Resolves a SegmentTemplate's $Number$/$RepresentationID$/$Time$ placeholders. */
function buildSegmentUrl(template, repId, number, time) {
  return template
    .replace(/\$RepresentationID\$/g, repId)
    .replace(/\$Number%0(\d+)d\$/g, (_, width) => String(number).padStart(parseInt(width, 10), '0'))
    .replace(/\$Number\$/g, String(number))
    .replace(/\$Time\$/g, String(time));
}

/**
 * Parses raw MPD XML text.
 * @param {string} text raw manifest content
 * @param {string} baseUrl the URL the manifest was fetched from
 */
function parseManifest(text, baseUrl) {
  const doc = parser.parse(text);
  const mpd = doc.MPD || doc.mpd;
  if (!mpd) throw new Error('Not a valid MPD document (no <MPD> root element)');

  const isLive = (mpd['@_type'] || 'static') === 'dynamic';
  const result = {
    type: 'dash',
    isLive,
    minimumUpdatePeriod: mpd['@_minimumUpdatePeriod'] || null,
    variants: [],       // video representations, shaped like the HLS "variants" for scoring reuse
    audioTracks: [],
    subtitleTracks: [],
    drm: null,
    segmentProbe: null, // { url, isInit } - a concrete URL we can download to test throughput
    freezeToken: null,  // a value we can compare across checks to detect a stalled live manifest
  };

  let mpdBaseUrl = baseUrl;
  const mpdBaseUrlEl = toArray(mpd.BaseURL)[0];
  if (mpdBaseUrlEl) {
    mpdBaseUrl = resolveUrl(baseUrl, typeof mpdBaseUrlEl === 'string' ? mpdBaseUrlEl : mpdBaseUrlEl['#text']);
  }

  const periods = toArray(mpd.Period);
  const period = periods[0]; // health-check the first period; good enough for liveness/quality purposes
  if (!period) throw new Error('MPD has no <Period> elements');

  let periodBaseUrl = mpdBaseUrl;
  const periodBaseUrlEl = toArray(period.BaseURL)[0];
  if (periodBaseUrlEl) {
    periodBaseUrl = resolveUrl(mpdBaseUrl, typeof periodBaseUrlEl === 'string' ? periodBaseUrlEl : periodBaseUrlEl['#text']);
  }

  const adaptationSets = toArray(period.AdaptationSet);
  let bestVideoRep = null;
  let bestVideoTemplate = null;
  let bestVideoAdaptationSet = null;

  for (const as of adaptationSets) {
    const contentType = as['@_contentType'] || (as['@_mimeType'] || '').split('/')[0];
    const cps = parseContentProtections(as.ContentProtection);
    if (cps.length > 0 && !result.drm) {
      const withSystem = cps.find((c) => c.drmSystem && c.drmSystem !== 'Generic CENC') || cps[0];
      result.drm = {
        method: withSystem.drmSystem || 'CENC',
        keyFormat: withSystem.schemeIdUri,
        defaultKeyId: cps.map((c) => c.defaultKeyId).find(Boolean) || null,
        laUrl: cps.map((c) => c.laUrl).find(Boolean) || null,
      };
    }

    if (contentType === 'audio' || as['@_mimeType'] === 'audio/mp4') {
      for (const rep of toArray(as.Representation)) {
        result.audioTracks.push({
          name: as['@_lang'] || rep['@_id'] || 'audio',
          language: as['@_lang'] || null,
          groupId: as['@_id'] != null ? String(as['@_id']) : null,
          isDefault: as['@_selectionPriority'] === '1' || false,
        });
      }
      continue;
    }

    if (contentType === 'video' || as['@_mimeType'] === 'video/mp4') {
      for (const rep of toArray(as.Representation)) {
        const bandwidth = rep['@_bandwidth'] ? parseInt(rep['@_bandwidth'], 10) : null;
        const width = rep['@_width'] ? parseInt(rep['@_width'], 10) : null;
        const height = rep['@_height'] ? parseInt(rep['@_height'], 10) : null;
        const variant = {
          bandwidth,
          resolution: width && height ? `${width}x${height}` : null,
          codecs: rep['@_codecs'] || as['@_codecs'] || null,
          frameRate: rep['@_frameRate'] ? parseFloat(String(rep['@_frameRate']).split('/')[0]) : null,
          id: rep['@_id'],
        };
        result.variants.push(variant);
        if (!bestVideoRep || (bandwidth || 0) > (bestVideoRep.bandwidth || 0)) {
          bestVideoRep = variant;
          bestVideoTemplate = rep.SegmentTemplate || as.SegmentTemplate;
          bestVideoAdaptationSet = as;
        }
      }
    }
  }

  // Build one concrete, fetchable segment URL for the best video representation so the
  // health checker can measure real throughput, same as it does for HLS.
  if (bestVideoRep && bestVideoTemplate) {
    const media = bestVideoTemplate['@_media'];
    const init = bestVideoTemplate['@_initialization'];
    const startNumber = bestVideoTemplate['@_startNumber'] ? parseInt(bestVideoTemplate['@_startNumber'], 10) : 1;
    const timescale = bestVideoTemplate['@_timescale'] ? parseInt(bestVideoTemplate['@_timescale'], 10) : 1;
    const segDuration = bestVideoTemplate['@_duration'] ? parseInt(bestVideoTemplate['@_duration'], 10) : null;

    let number = startNumber;
    let time = 0;
    const timeline = bestVideoTemplate.SegmentTimeline;
    if (timeline && timeline.S) {
      // Walk the timeline to find the last (most recent) segment's start time - this is our
      // freeze-detection token: if it hasn't advanced next time we check, the manifest is stale.
      let t = 0;
      let count = 0;
      for (const s of toArray(timeline.S)) {
        if (s['@_t'] !== undefined) t = parseInt(s['@_t'], 10);
        const r = s['@_r'] ? parseInt(s['@_r'], 10) : 0;
        const d = s['@_d'] ? parseInt(s['@_d'], 10) : 0;
        for (let i = 0; i <= r; i++) {
          time = t;
          t += d;
          count += 1;
        }
      }
      number = startNumber + count - 1;
    } else if (isLive && segDuration && timescale) {
      // No explicit timeline: estimate current segment number from wall-clock time.
      const nowSec = Date.now() / 1000;
      const availabilityStart = mpd['@_availabilityStartTime'] ? Date.parse(mpd['@_availabilityStartTime']) / 1000 : nowSec;
      const elapsed = Math.max(0, nowSec - availabilityStart);
      number = startNumber + Math.floor(elapsed / (segDuration / timescale));
    }

    const templateBase = resolveUrl(periodBaseUrl, '');
    const repId = bestVideoRep.id;
    if (init) {
      result.segmentProbe = { url: buildSegmentUrl(resolveUrl(templateBase, init), repId, number, time), isInit: true };
    } else if (media) {
      result.segmentProbe = {
        url: buildSegmentUrl(resolveUrl(templateBase, media), repId, number, time),
        isInit: false,
        durationSec: segDuration && timescale ? segDuration / timescale : null,
      };
    }
    result.freezeToken = `${repId}:${number}:${time}`;
  }

  return result;
}

module.exports = { parseManifest };
