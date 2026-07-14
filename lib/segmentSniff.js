'use strict';

/**
 * Inspects the first bytes of a downloaded "segment" to confirm it's actually
 * media data, not an error/redirect/expired-token page that a misbehaving
 * server returned with a 200 OK (extremely common cause of a stream that
 * "downloads fine" but never actually plays).
 */
function sniffSegment(buffer) {
  if (!buffer || buffer.byteLength < 4) {
    return { valid: false, reason: 'empty or truncated response' };
  }
  const bytes = new Uint8Array(buffer);

  // MPEG-TS: every packet starts with sync byte 0x47, repeating every 188 bytes.
  const looksLikeSyncByte = bytes[0] === 0x47;
  const syncByteRepeats = bytes.length <= 188 || bytes[188] === 0x47;
  if (looksLikeSyncByte && syncByteRepeats) {
    return { valid: true, format: 'mpeg-ts' };
  }

  // fMP4 / CMAF: an ISO-BMFF box - 4-byte size, then a 4-byte ASCII box type.
  if (bytes.length >= 8) {
    const boxType = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    if (['ftyp', 'styp', 'moof', 'moov', 'mdat', 'sidx', 'free', 'skip'].includes(boxType)) {
      return { valid: true, format: 'fmp4' };
    }
  }

  // Looks like a text-based error page instead of binary media.
  const head = Buffer.from(buffer.slice(0, 64)).toString('utf8').trim().toLowerCase();
  if (
    head.startsWith('<') ||
    head.startsWith('{') ||
    head.startsWith('http/') ||
    head.includes('<!doctype') ||
    head.includes('error')
  ) {
    return { valid: false, reason: 'response body looks like text/HTML/JSON, not media (likely an error or expired-link page)' };
  }

  return { valid: false, reason: 'unrecognized binary format (not MPEG-TS or fMP4)' };
}

module.exports = { sniffSegment };
