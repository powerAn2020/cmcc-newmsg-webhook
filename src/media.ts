import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { MediaType, NativeSendRequest } from './types.js';

const types = new Set<MediaType>(['IMAGE', 'TEXT', 'AUDIO', 'VIDEO', 'FILE']);
export const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

export function inferMediaType(fileName: string, mimeType = ''): MediaType {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith('image/')) return 'IMAGE';
  if (mime.startsWith('audio/')) return 'AUDIO';
  if (mime.startsWith('video/')) return 'VIDEO';
  if (mime.startsWith('text/')) return 'TEXT';

  const extension = fileName.split('.').pop()?.toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(extension ?? '')) return 'IMAGE';
  if (['mp3', 'wav', 'aac', 'm4a', 'ogg', 'amr'].includes(extension ?? '')) return 'AUDIO';
  if (['mp4', 'webm', '3gp', 'mov', 'avi'].includes(extension ?? '')) return 'VIDEO';
  if (['txt', 'md'].includes(extension ?? '')) return 'TEXT';
  return 'FILE';
}

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
  if (body.mediaSize !== undefined && (!Number.isInteger(body.mediaSize) || body.mediaSize < 0 || body.mediaSize > MAX_MEDIA_BYTES)) return `mediaSize must be between 0 and ${MAX_MEDIA_BYTES}`;
  return undefined;
}
export function isCmccMediaUrl(urlStr: string, uploadUrlStr?: string): boolean {
  try {
    const url = new URL(urlStr);
    if (uploadUrlStr) {
      try {
        const uploadUrl = new URL(uploadUrlStr);
        if (url.hostname.toLowerCase() === uploadUrl.hostname.toLowerCase()) return true;
      } catch {
        // ignore
      }
    }
    const host = url.hostname.toLowerCase();
    return host.endsWith('.cmicmaap.com') || host === 'cmicmaap.com';
  } catch {
    return false;
  }
}

export interface StagedMediaFile {
  path: string;
  name: string;
  size: number;
  mimeType: string;
}

function extractFilenameFromHeader(header: string | null): string | undefined {
  if (!header) return undefined;
  const matchStar = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (matchStar) {
    try {
      return decodeURIComponent(matchStar[1].trim());
    } catch {
      // ignore
    }
  }
  const match = header.match(/filename=["']?([^"';]+)["']?/i);
  if (match) {
    return match[1].trim();
  }
  return undefined;
}

export function defaultExtensionForType(mediaType?: MediaType, mimeType = ''): string {
  const mime = mimeType.toLowerCase();
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  if (mime.includes('png')) return '.png';
  if (mime.includes('gif')) return '.gif';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('mp4')) return '.mp4';
  if (mime.includes('mpeg') || mime.includes('mp3')) return '.mp3';
  if (mime.includes('text') || mime.includes('plain')) return '.txt';

  switch (mediaType) {
    case 'IMAGE': return '.jpg';
    case 'AUDIO': return '.mp3';
    case 'VIDEO': return '.mp4';
    case 'TEXT': return '.txt';
    case 'FILE':
    default: return '.bin';
  }
}

export async function downloadRemoteMedia(
  mediaUrl: string,
  mediaType?: MediaType,
  timeoutMs = 60000,
  fetchImpl: typeof fetch = fetch
): Promise<StagedMediaFile> {
  const mediaError = validateMedia({ type: 'send', mediaUrl, mediaType: mediaType ?? 'FILE' });
  if (mediaError) throw new Error(mediaError);

  let response: Response;
  try {
    response = await fetchImpl(mediaUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
  } catch (error) {
    throw new Error(`Failed to download remote media: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) {
    throw new Error(`Failed to download remote media from ${mediaUrl} (HTTP ${response.status})`);
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isInteger(contentLength) && contentLength > MAX_MEDIA_BYTES) {
    throw new Error(`Remote media exceeds ${MAX_MEDIA_BYTES} bytes limit`);
  }

  const contentType = response.headers.get('content-type') || '';
  let filename = extractFilenameFromHeader(response.headers.get('content-disposition'));
  if (!filename) {
    try {
      const pathname = new URL(mediaUrl).pathname;
      const basename = path.basename(pathname);
      if (basename && basename !== '/' && !basename.startsWith('.')) {
        filename = decodeURIComponent(basename);
      }
    } catch {
      // ignore
    }
  }

  if (!filename || !path.extname(filename)) {
    const ext = defaultExtensionForType(mediaType, contentType);
    filename = `${filename || `remote_${Date.now()}`}${ext}`;
  }
  filename = path.basename(filename).replace(/[\r\n"]/g, '_');

  const filePath = path.join(os.tmpdir(), `cmcc-remote-${crypto.randomUUID()}`);
  let totalBytes = 0;

  try {
    if (!response.body) throw new Error('Response body is null');
    const writeStream = createWriteStream(filePath, { flags: 'wx' });

    const reader = response.body.getReader();
    const nodeStream = new Readable({
      async read() {
        try {
          const { done, value } = await reader.read();
          if (done) {
            this.push(null);
          } else {
            totalBytes += value.length;
            if (totalBytes > MAX_MEDIA_BYTES) {
              this.destroy(new Error(`Remote media file exceeds ${MAX_MEDIA_BYTES} bytes`));
              return;
            }
            this.push(Buffer.from(value));
          }
        } catch (err) {
          this.destroy(err as Error);
        }
      }
    });

    await pipeline(nodeStream, writeStream);
    const info = await stat(filePath);

    return {
      path: filePath,
      name: filename,
      size: info.size,
      mimeType: contentType || 'application/octet-stream'
    };
  } catch (error) {
    await unlink(filePath).catch(() => undefined);
    throw error;
  }
}
