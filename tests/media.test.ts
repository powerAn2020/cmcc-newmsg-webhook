import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  defaultExtensionForType,
  downloadRemoteMedia,
  inferMediaType,
  isCmccMediaUrl,
  validateMedia
} from '../src/media.js';

describe('validateMedia', () => {
  it('accepts public media URL with supported type', () => {
    expect(validateMedia({ type: 'send', mediaType: 'IMAGE', mediaUrl: 'https://cdn.example.com/a.png' })).toBeUndefined();
  });

  it('rejects local and private URLs', () => {
    expect(validateMedia({ type: 'send', mediaType: 'IMAGE', mediaUrl: 'file:///tmp/a.png' })).toContain('http');
    expect(validateMedia({ type: 'send', mediaType: 'IMAGE', mediaUrl: 'http://127.0.0.1/a.png' })).toContain('not allowed');
  });

  it('requires media type and enforces 200 MB limit', () => {
    expect(validateMedia({ type: 'send', mediaUrl: 'https://cdn.example.com/a.png' })).toContain('mediaType');
    expect(validateMedia({ type: 'send', mediaType: 'IMAGE', mediaUrl: 'https://cdn.example.com/a.png', mediaSize: 200 * 1024 * 1024 + 1 })).toContain('209715200');
  });

  it('infers plugin-compatible media types', () => {
    expect(inferMediaType('photo.bin', 'image/png')).toBe('IMAGE');
    expect(inferMediaType('voice.amr')).toBe('AUDIO');
    expect(inferMediaType('archive.zip')).toBe('FILE');
  });
});

describe('isCmccMediaUrl', () => {
  it('detects CMCC domain URLs correctly', () => {
    expect(isCmccMediaUrl('https://5gvas01.cmicmaap.com/aifile/test.jpg')).toBe(true);
    expect(isCmccMediaUrl('https://cmicmaap.com/file.png')).toBe(true);
    expect(isCmccMediaUrl('https://sub.5gvas.cmicmaap.com/file')).toBe(true);
  });

  it('matches configured uploadUrl host', () => {
    expect(isCmccMediaUrl('https://custom-gw.local/files/abc', 'https://custom-gw.local/api/upload')).toBe(true);
  });

  it('returns false for external third-party or invalid URLs', () => {
    expect(isCmccMediaUrl('https://cdn.example.com/photo.jpg')).toBe(false);
    expect(isCmccMediaUrl('https://cmicmaap.com.attacker.com/file.png')).toBe(false);
    expect(isCmccMediaUrl('not-a-valid-url')).toBe(false);
  });
});

describe('defaultExtensionForType', () => {
  it('prefers mime type detection', () => {
    expect(defaultExtensionForType('IMAGE', 'image/png')).toBe('.png');
    expect(defaultExtensionForType('VIDEO', 'video/mp4')).toBe('.mp4');
    expect(defaultExtensionForType('AUDIO', 'audio/mpeg')).toBe('.mp3');
    expect(defaultExtensionForType('TEXT', 'text/plain')).toBe('.txt');
  });

  it('falls back to mediaType defaults', () => {
    expect(defaultExtensionForType('IMAGE')).toBe('.jpg');
    expect(defaultExtensionForType('AUDIO')).toBe('.mp3');
    expect(defaultExtensionForType('VIDEO')).toBe('.mp4');
    expect(defaultExtensionForType('TEXT')).toBe('.txt');
    expect(defaultExtensionForType('FILE')).toBe('.bin');
  });
});

describe('downloadRemoteMedia', () => {
  it('downloads remote file safely and returns StagedMediaFile', async () => {
    const fakeBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('fake-image-bytes'));
        controller.close();
      }
    });

    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'image/jpeg',
        'content-disposition': 'attachment; filename="photo.jpg"'
      }),
      body: fakeBody
    })) as unknown as typeof fetch;

    const staged = await downloadRemoteMedia('https://example.com/avatar.jpg', 'IMAGE', 5000, mockFetch);
    try {
      expect(staged.name).toBe('photo.jpg');
      expect(staged.size).toBe(16);
      expect(staged.mimeType).toBe('image/jpeg');
      expect(fs.existsSync(staged.path)).toBe(true);
      expect(fs.readFileSync(staged.path, 'utf8')).toBe('fake-image-bytes');
    } finally {
      if (fs.existsSync(staged.path)) {
        fs.unlinkSync(staged.path);
      }
    }
  });

  it('rejects private IPs and non-ok HTTP responses', async () => {
    await expect(downloadRemoteMedia('http://127.0.0.1/file.jpg', 'IMAGE')).rejects.toThrow('host is not allowed');

    const mockFetch404 = vi.fn(async () => ({
      ok: false,
      status: 404,
      headers: new Headers()
    })) as unknown as typeof fetch;

    await expect(downloadRemoteMedia('https://example.com/notfound.jpg', 'IMAGE', 5000, mockFetch404)).rejects.toThrow('HTTP 404');
  });
});

