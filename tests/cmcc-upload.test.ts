import { describe, expect, it, vi } from 'vitest';
import { CmccUploader } from '../src/cmcc-upload.js';

describe('CMCC media upload', () => {
  it('uses plugin-compatible multipart fields and returns data URL', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://cmcc.example/api/upload');
      const form = init?.body as FormData;
      expect(form.get('apiKey')).toBe('ak_test');
      expect((form.get('file') as File).name).toBe('report.txt');
      return new Response(JSON.stringify({ code: 10200, message: 'success', data: 'https://cdn.example/report.txt' }));
    });
    const uploader = new CmccUploader(
      'https://cmcc.example/api/',
      5000,
      fetchMock as typeof fetch,
      async () => new Blob(['report'])
    );

    await expect(uploader.upload('ak_test', 'unused', 'report.txt')).resolves.toBe('https://cdn.example/report.txt');
  });

  it('rejects unsuccessful DataResult responses', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 10500, message: 'invalid api key' })));
    const uploader = new CmccUploader(
      'https://cmcc.example/api',
      5000,
      fetchMock as typeof fetch,
      async () => new Blob(['report'])
    );

    await expect(uploader.upload('bad', 'unused', 'report.txt')).rejects.toThrow('invalid api key');
  });
});
