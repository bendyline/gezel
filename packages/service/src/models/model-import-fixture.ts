/**
 * A fake Hugging Face Hub and an in-memory GGUF, shared by the import tests.
 */

import { createHash } from 'node:crypto';

// ── a GGUF small enough to build in memory ──

export type Meta = [key: string, value: string | number];

export function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}
export function u64(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}
export function str(s: string): Buffer {
  const utf8 = Buffer.from(s, 'utf8');
  return Buffer.concat([u64(utf8.byteLength), utf8]);
}

export function buildGguf(opts: {
  meta: Meta[];
  tensors?: Array<{ name: string; dims: number[]; type: number }>;
  dataBytes?: number;
}): Buffer {
  const tensors = opts.tensors ?? [];
  const parts: Buffer[] = [
    Buffer.from('GGUF', 'ascii'),
    u32(3),
    u64(tensors.length),
    u64(opts.meta.length),
  ];
  for (const [key, value] of opts.meta) {
    parts.push(str(key));
    if (typeof value === 'string') parts.push(u32(8), str(value));
    else parts.push(u32(4), u32(value));
  }
  let offset = 0;
  for (const tensor of tensors) {
    parts.push(str(tensor.name), u32(tensor.dims.length));
    for (const dim of tensor.dims) parts.push(u64(dim));
    parts.push(u32(tensor.type), u64(offset));
    offset += 64;
  }
  const header = Buffer.concat(parts);
  const padded = Math.ceil(header.length / 32) * 32;
  return Buffer.concat([
    header,
    Buffer.alloc(padded - header.length),
    Buffer.alloc(opts.dataBytes ?? 4096, 7),
  ]);
}

export const TOOL_TEMPLATE =
  '{%- if tools %}{{ tools | tojson }}{% endif %}{% for m in messages %}<|im_start|>{{ m.role }}\n{{ m.content }}<|im_end|>{% endfor %}';

export function chatGguf(overrides: Meta[] = []): Buffer {
  const meta = new Map<string, string | number>([
    ['general.architecture', 'qwen3'],
    ['general.name', 'Tiny Qwen'],
    ['general.size_label', '8B'],
    ['general.file_type', 15],
    ['qwen3.context_length', 40_960],
    ['qwen3.block_count', 2],
    ['qwen3.embedding_length', 64],
    ['qwen3.attention.head_count', 4],
    ['qwen3.attention.head_count_kv', 2],
    ['tokenizer.ggml.model', 'gpt2'],
    ['tokenizer.chat_template', TOOL_TEMPLATE],
  ]);
  for (const [key, value] of overrides) meta.set(key, value);
  return buildGguf({
    meta: [...meta.entries()],
    tensors: [
      { name: 'token_embd.weight', dims: [64, 100], type: 12 },
      { name: 'blk.0.attn_q.weight', dims: [64, 64], type: 12 },
      { name: 'output_norm.weight', dims: [64], type: 0 },
    ],
  });
}

export const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
export const COMMIT = 'a'.repeat(40);
export const REPO = 'someone/Tiny-Qwen-GGUF';

// ── a fake Hub ──

export interface FakeRepo {
  files: Record<string, Buffer>;
  gated?: false | 'auto' | 'manual';
  license?: string;
  /** Paths the Hub stores in git rather than LFS: listed without a SHA-256. */
  plainGit?: string[];
  tags?: string[];
  /** `cardData.base_model`. */
  baseModel?: string;
  /** Other repos the fake Hub serves files from at `main` (a base model's configs). */
  others?: Record<string, Record<string, Buffer>>;
}

export function fakeHub(repo: FakeRepo, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    seen.push(url.pathname);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.pathname === `/api/models/${REPO}`) {
      return json({
        id: REPO,
        sha: COMMIT,
        gated: repo.gated ?? false,
        private: false,
        author: 'someone',
        cardData: {
          ...(repo.license ? { license: repo.license } : {}),
          ...(repo.baseModel ? { base_model: repo.baseModel } : {}),
        },
        tags: repo.tags ?? ['gguf'],
      });
    }
    if (url.pathname === `/api/models/${REPO}/tree/${COMMIT}`) {
      return json(
        Object.entries(repo.files).map(([path, bytes]) => ({
          type: 'file',
          path,
          size: bytes.length,
          ...(repo.plainGit?.includes(path)
            ? { oid: 'b'.repeat(40) }
            : { lfs: { oid: sha256(bytes), size: bytes.length } }),
        })),
      );
    }
    const prefix = `/${REPO}/resolve/${COMMIT}/`;
    if (url.pathname.startsWith(prefix)) {
      const path = decodeURIComponent(url.pathname.slice(prefix.length));
      const bytes = repo.files[path];
      if (!bytes) return new Response('missing', { status: 404 });
      const range = new Headers(init?.headers).get('range');
      const match = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
      if (match) {
        const start = Number(match[1]);
        const end = match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
        const slice = bytes.subarray(start, end + 1);
        return new Response(slice, {
          status: 206,
          headers: {
            'content-length': String(slice.length),
            'content-range': `bytes ${start}-${end}/${bytes.length}`,
            'accept-ranges': 'bytes',
          },
        });
      }
      return new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.length), 'accept-ranges': 'bytes' },
      });
    }
    for (const [other, files] of Object.entries(repo.others ?? {})) {
      const otherPrefix = `/${other}/resolve/main/`;
      if (!url.pathname.startsWith(otherPrefix)) continue;
      const bytes = files[decodeURIComponent(url.pathname.slice(otherPrefix.length))];
      if (bytes) return new Response(bytes, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}
