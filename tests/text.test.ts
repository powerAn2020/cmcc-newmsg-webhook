import { describe, expect, it } from 'vitest';
import { chunkText, markdownToPlainText, OPENCLAW_TEXT_CHUNK_LIMIT } from '../src/text.js';

describe('OpenClaw-compatible text handling', () => {
  it('converts Markdown formatting to plain text', () => {
    expect(markdownToPlainText('# Alert\n**Service** [dashboard](https://example.com)\n- offline')).toBe(
      'Alert\nService dashboard\n• offline'
    );
  });

  it('splits long text without breaking surrogate pairs', () => {
    const text = `${'a'.repeat(OPENCLAW_TEXT_CHUNK_LIMIT - 1)}😀${'b'.repeat(100)}`;
    const chunks = chunkText(text);
    expect(chunks.join('')).toBe(text);
    expect(chunks).toHaveLength(2);
    expect(chunks.every(chunk => chunk.length <= OPENCLAW_TEXT_CHUNK_LIMIT)).toBe(true);
    expect(chunks[0].endsWith('\ud83d')).toBe(false);
  });
});
