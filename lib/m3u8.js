'use strict';

/**
 * Lightweight HLS (.m3u8) parser.
 * No external dependency needed - HLS is a simple line-based text format.
 * Handles both "master" playlists (list of variant streams) and
 * "media" playlists (list of actual segments).
 */

function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).toString();
  } catch (e) {
    return relative;
  }
}

function parseAttributes(attrString) {
  // Parses KEY=VALUE,KEY="VALUE",KEY=VALUE style attribute lists used throughout HLS tags.
  const attrs = {};
  const regex = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let match;
  while ((match = regex.exec(attrString)) !== null) {
    const key = match[1];
    const value = match[3] !== undefined ? match[3] : match[2];
    attrs[key] = value;
  }
  return attrs;
}

/**
 * Parses raw m3u8 text.
 * @param {string} text raw manifest content
 * @param {string} baseUrl the URL the manifest was fetched from (for resolving relative URIs)
 * @returns {object} parsed manifest info
 */
function parseManifest(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());

  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));

  const result = {
    type: isMaster ? 'master' : 'media',
    variants: [],       // for master playlists
    audioTracks: [],    // #EXT-X-MEDIA TYPE=AUDIO
    subtitleTracks: [], // #EXT-X-MEDIA TYPE=SUBTITLES
    segments: [],        // for media playlists
    targetDuration: null,
    isLive: true,        // media playlists without #EXT-X-ENDLIST are live
    drm: null,           // #EXT-X-KEY info if present
    version: null,
    mediaSequence: null, // #EXT-X-MEDIA-SEQUENCE - lets us detect a frozen/stale live playlist
  };

  let pendingStreamInf = null;
  let pendingSegmentDuration = null;
  let pendingKey = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    if (line.startsWith('#EXT-X-VERSION:')) {
      result.version = line.split(':')[1];
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      result.targetDuration = parseFloat(line.split(':')[1]);
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      result.mediaSequence = parseInt(line.split(':')[1], 10);
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      result.isLive = false;
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttributes(line.substring('#EXT-X-MEDIA:'.length));
      const track = {
        type: attrs.TYPE || null,
        groupId: attrs['GROUP-ID'] || null,
        name: attrs.NAME || null,
        language: attrs.LANGUAGE || null,
        isDefault: attrs.DEFAULT === 'YES',
        autoSelect: attrs.AUTOSELECT === 'YES',
        uri: attrs.URI ? resolveUrl(baseUrl, attrs.URI) : null,
      };
      if (track.type === 'AUDIO') result.audioTracks.push(track);
      if (track.type === 'SUBTITLES') result.subtitleTracks.push(track);
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseAttributes(line.substring('#EXT-X-STREAM-INF:'.length));
      pendingStreamInf = {
        bandwidth: attrs.BANDWIDTH ? parseInt(attrs.BANDWIDTH, 10) : null,
        averageBandwidth: attrs['AVERAGE-BANDWIDTH'] ? parseInt(attrs['AVERAGE-BANDWIDTH'], 10) : null,
        resolution: attrs.RESOLUTION || null,
        codecs: attrs.CODECS || null,
        frameRate: attrs['FRAME-RATE'] ? parseFloat(attrs['FRAME-RATE']) : null,
        audioGroup: attrs.AUDIO || null,
      };
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.substring('#EXT-X-KEY:'.length));
      pendingKey = {
        method: attrs.METHOD || null,
        uri: attrs.URI || null,
        keyFormat: attrs.KEYFORMAT || null,
        ivPresent: !!attrs.IV,
      };
      result.drm = pendingKey; // last one wins; good enough for health-check purposes
    } else if (line.startsWith('#EXTINF:')) {
      pendingSegmentDuration = parseFloat(line.substring('#EXTINF:'.length).split(',')[0]);
    } else if (!line.startsWith('#')) {
      // This is a URI line - either a variant playlist or a segment, depending on context.
      if (isMaster && pendingStreamInf) {
        result.variants.push({
          ...pendingStreamInf,
          url: resolveUrl(baseUrl, line),
        });
        pendingStreamInf = null;
      } else if (!isMaster) {
        result.segments.push({
          url: resolveUrl(baseUrl, line),
          duration: pendingSegmentDuration,
        });
        pendingSegmentDuration = null;
      }
    }
  }

  return result;
}

/** Picks the "best" (highest bandwidth) variant from a master playlist's variant list. */
function pickBestVariant(variants) {
  if (!variants || variants.length === 0) return null;
  return variants.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
}

module.exports = { parseManifest, pickBestVariant, resolveUrl };
