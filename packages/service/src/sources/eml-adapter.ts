import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { MaterializedDoc, SourceAdapter } from './types.js';

/**
 * Mail source adapter: `.eml` (RFC 822) → markdown + frontmatter. Mirrors each
 * message so the index gains "meta-inbox" search for free — the headers
 * (from/to/subject/date/thread) land in `metadata` for filtering, the body
 * becomes searchable chunks. A deliberately small parser: header unfolding +
 * first text/plain part of a multipart body. Not a full MIME implementation
 * (no transfer-encoding decode), enough for indexing.
 */
export class EmlMailAdapter implements SourceAdapter {
  readonly kind = 'mail';

  matches(path: string): boolean {
    return extname(path).toLowerCase() === '.eml';
  }

  async convert(absPath: string): Promise<MaterializedDoc | null> {
    let raw: string;
    try {
      raw = await readFile(absPath, 'utf8');
    } catch {
      return null;
    }
    const { headers, body } = splitMessage(raw);
    const get = (k: string) => headers.get(k.toLowerCase()) ?? '';

    const subject = get('subject') || '(no subject)';
    const frontmatter: Record<string, string> = {};
    for (const k of ['from', 'to', 'cc', 'subject', 'date']) {
      const v = get(k);
      if (v) frontmatter[k] = v;
    }
    const thread = get('in-reply-to') || get('references').split(/\s+/)[0] || get('message-id');
    if (thread) frontmatter.thread = thread.trim();
    frontmatter.modality_hint = 'email';

    const text = extractTextBody(headers, body).trim();
    const markdown = `# ${subject}\n\n${text}`;

    const base = basename(absPath).replace(/\.eml$/i, '');
    return { relPath: base, frontmatter, markdown };
  }
}

function splitMessage(raw: string): { headers: Map<string, string>; body: string } {
  const idx = raw.search(/\r?\n\r?\n/);
  const headerBlock = idx === -1 ? raw : raw.slice(0, idx);
  const body = idx === -1 ? '' : raw.slice(idx).replace(/^\r?\n\r?\n/, '');
  return { headers: parseHeaders(headerBlock), body };
}

function parseHeaders(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  // Unfold continuation lines (leading whitespace continues the previous header).
  const unfolded: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += ` ${line.trim()}`;
    } else {
      unfolded.push(line);
    }
  }
  for (const line of unfolded) {
    const m = /^([!-9;-~]+):\s*(.*)$/.exec(line);
    if (m) {
      const key = m[1]!.toLowerCase();
      if (!headers.has(key)) headers.set(key, m[2]!.trim());
    }
  }
  return headers;
}

function extractTextBody(headers: Map<string, string>, body: string): string {
  const ct = headers.get('content-type') ?? '';
  const boundaryMatch = /boundary="?([^";]+)"?/i.exec(ct);
  if (!/multipart/i.test(ct) || !boundaryMatch) return body;

  const boundary = `--${boundaryMatch[1]}`;
  const parts = body.split(boundary);
  for (const part of parts) {
    const sep = part.search(/\r?\n\r?\n/);
    if (sep === -1) continue;
    const partHeaders = part.slice(0, sep).toLowerCase();
    if (partHeaders.includes('text/plain')) {
      return part
        .slice(sep)
        .replace(/^\r?\n\r?\n/, '')
        .trim();
    }
  }
  // No text/plain part — fall back to the first part's body.
  const first = parts[1] ?? '';
  const sep = first.search(/\r?\n\r?\n/);
  return sep === -1 ? body : first.slice(sep).trim();
}
