import type { MediaType, NativeSendRequest } from './types.js';

const types = new Set<MediaType>(['IMAGE', 'TEXT', 'AUDIO', 'VIDEO', 'FILE']);

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  if (/^(10|127)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  const m = h.match(/^172\.(\d{1,3})\./);
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

export function validateMedia(body: NativeSendRequest): string | undefined {
  if (!body.mediaUrl) return undefined;
  let url: URL;
  try { url = new URL(body.mediaUrl); } catch { return 'mediaUrl must be a valid URL'; }
  if (!['http:', 'https:'].includes(url.protocol)) return 'mediaUrl must use http or https';
  if (isPrivateHost(url.hostname)) return 'mediaUrl host is not allowed';
  if (body.thumbnailUrl) {
    try {
      const thumb = new URL(body.thumbnailUrl);
      if (!['http:', 'https:'].includes(thumb.protocol) || isPrivateHost(thumb.hostname)) return 'thumbnailUrl is not allowed';
    } catch { return 'thumbnailUrl must be a valid URL'; }
  }
  if (!body.mediaType || !types.has(body.mediaType)) return 'mediaType is required and must be IMAGE, TEXT, AUDIO, VIDEO, or FILE';
  if (body.mediaSize !== undefined && (!Number.isInteger(body.mediaSize) || body.mediaSize < 0 || body.mediaSize > 200 * 1024 * 1024)) return 'mediaSize must be between 0 and 209715200';
  return undefined;
}
