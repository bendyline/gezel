import { vi } from 'vitest';

/** The store's base URL as the Android plugin reports it. */
export const BASE_URL = 'https://localhost/_gezel_knowledge';

/** A word-level tokenizer: enough of the real format for the query embedder. */
export const VOCAB = { '[UNK]': 0, query: 1, ':': 2, panama: 3, hotel: 4, warm: 5 } as const;
const TOKENIZER = {
  version: '1.0',
  truncation: null,
  padding: null,
  added_tokens: [],
  normalizer: { type: 'Lowercase' },
  pre_tokenizer: { type: 'Whitespace' },
  post_processor: null,
  decoder: null,
  model: { type: 'WordLevel', vocab: VOCAB, unk_token: '[UNK]' },
};

/**
 * A fetch that serves a query model's tokenizer files from the store in byte
 * ranges, as the plugins' file handlers do; any other path is a 404.
 */
export function serveTokenizer(storeId: string) {
  const files = new Map([
    [`${BASE_URL}/${storeId}/tokenizer.json`, new TextEncoder().encode(JSON.stringify(TOKENIZER))],
    [`${BASE_URL}/${storeId}/tokenizer_config.json`, new TextEncoder().encode('{}')],
  ]);
  return vi.fn(async (url: string, init?: RequestInit) => {
    const bytes = files.get(url);
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('Range') ?? '');
    if (!bytes || !range) return new Response(null, { status: 404 });
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), bytes.length - 1);
    return new Response(bytes.slice(start, end + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` },
    });
  });
}
