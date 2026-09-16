import { describe, expect, it } from 'vitest';
import { inferMediaType, validateMedia } from '../src/media.js';

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
