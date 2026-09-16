export const OPENCLAW_TEXT_CHUNK_LIMIT = 2000;

export function markdownToPlainText(markdown: string): string {
  let text = markdown;
  text = text.replace(/```[\s\S]*?```/g, match => match.slice(3, -3).trim());
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1');
  text = text.replace(/(?<!_)_([^_]+)_(?!_)/g, '$1');
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/^#{3,6}(.?)/gm, '$1');
  text = text.replace(/^\[[^\]]+\]\s*/gm, '');
  text = text.replace(/^[\s]*[-*]\s+/gm, '• ');
  text = text.replace(/^[\s]*\d+\.\s+/gm, '• ');
  text = text.replace(/^>\s*/gm, '');
  text = text.replace(/^(-{3,}|\*{3,}|_{3,})\s*$/gm, '');
  text = text.replace(/~~([^~]+)~~/g, '$1');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

export function chunkText(text: string, limit = OPENCLAW_TEXT_CHUNK_LIMIT): string[] {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('text chunk limit must be a positive integer');
  if (!text) return [];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let end = limit;
    const before = remaining.charCodeAt(end - 1);
    const after = remaining.charCodeAt(end);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end -= 1;

    const candidate = remaining.slice(0, end);
    const newline = candidate.lastIndexOf('\n');
    const space = candidate.lastIndexOf(' ');
    const boundary = Math.max(newline, space);
    if (boundary >= Math.floor(limit * 0.6)) end = boundary + 1;

    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
