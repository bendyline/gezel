import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readGgufSummary } from './gguf-metadata.js';

/**
 * Build a synthetic GGUF binary in-memory so we can test the parser
 * without committing a multi-MB fixture or hitting the network.
 *
 * Layout follows the v3 spec:
 *   magic "GGUF" (4)
 *   version uint32
 *   tensor_count uint64
 *   metadata_kv_count uint64
 *   then metadata_kv_count entries of (key gguf_string, type uint32, value)
 */

const VTYPE = {
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12,
} as const;

class GgufBuilder {
  private parts: Buffer[] = [];
  private metaCount = 0n;

  header(version = 3, tensorCount = 0n) {
    this.parts.push(Buffer.from('GGUF', 'ascii'));
    this.parts.push(this.u32(version));
    this.parts.push(this.u64(tensorCount));
    // metadata-count slot (8 bytes), patched in finish() once we
    // know how many entries we wrote.
    this.parts.push(this.u64(0n));
    return this;
  }

  metaString(key: string, value: string) {
    this.parts.push(this.gguf_string(key));
    this.parts.push(this.u32(VTYPE.STRING));
    this.parts.push(this.gguf_string(value));
    this.metaCount++;
    return this;
  }

  metaU32(key: string, value: number) {
    this.parts.push(this.gguf_string(key));
    this.parts.push(this.u32(VTYPE.UINT32));
    this.parts.push(this.u32(value));
    this.metaCount++;
    return this;
  }

  metaU64(key: string, value: bigint) {
    this.parts.push(this.gguf_string(key));
    this.parts.push(this.u32(VTYPE.UINT64));
    this.parts.push(this.u64(value));
    this.metaCount++;
    return this;
  }

  metaBool(key: string, value: boolean) {
    this.parts.push(this.gguf_string(key));
    this.parts.push(this.u32(VTYPE.BOOL));
    const b = Buffer.alloc(1);
    b.writeUInt8(value ? 1 : 0, 0);
    this.parts.push(b);
    this.metaCount++;
    return this;
  }

  /**
   * Add an array of strings — the most common metadata array shape
   * (e.g. tokenizer vocab) and the one the parser must skip
   * correctly without materialising into memory.
   */
  metaStringArray(key: string, values: string[]) {
    this.parts.push(this.gguf_string(key));
    this.parts.push(this.u32(VTYPE.ARRAY));
    this.parts.push(this.u32(VTYPE.STRING));
    this.parts.push(this.u64(BigInt(values.length)));
    for (const v of values) this.parts.push(this.gguf_string(v));
    this.metaCount++;
    return this;
  }

  finish(): Buffer {
    // Patch the metadata-count field: it sits at offset
    // 4 (magic) + 4 (version) + 8 (tensor_count) = 16.
    const blob = Buffer.concat(this.parts);
    blob.writeBigUInt64LE(this.metaCount, 16);
    return blob;
  }

  private u32(n: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n, 0);
    return b;
  }
  private u64(n: bigint): Buffer {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(n, 0);
    return b;
  }
  private gguf_string(s: string): Buffer {
    const utf8 = Buffer.from(s, 'utf8');
    const out = Buffer.alloc(8 + utf8.byteLength);
    out.writeBigUInt64LE(BigInt(utf8.byteLength), 0);
    utf8.copy(out, 8);
    return out;
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gguf-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readGgufSummary', () => {
  it('extracts architecture, name, context length, file type, and chat template', () => {
    const blob = new GgufBuilder()
      .header(3, 1234n)
      .metaString('general.architecture', 'qwen2')
      .metaString('general.name', 'qwen2.5-test')
      .metaU32('general.file_type', 15) // MOSTLY_Q4_K_M
      .metaU32('qwen2.context_length', 32768)
      .metaString('tokenizer.chat_template', '{%- if tools %}\n{{- "tool intro" }}\n{%- endif %}')
      .finish();
    const path = join(dir, 'synthetic.gguf');
    writeFileSync(path, blob);

    const s = readGgufSummary(path);
    expect(s.magic).toBe('GGUF');
    expect(s.version).toBe(3);
    expect(s.tensorCount).toBe(1234n);
    expect(s.architecture).toBe('qwen2');
    expect(s.name).toBe('qwen2.5-test');
    expect(s.contextLength).toBe(32768n);
    expect(s.fileType).toBe(15);
    expect(s.fileTypeName).toBe('MOSTLY_Q4_K_M');
    expect(s.chatTemplate).toBeDefined();
    expect(s.chatTemplateMissing).toBe(false);
    expect(s.chatTemplate).toContain('tool intro');
    // For this synthetic blob the parser legitimately reads to the
    // end (no tensor data follows); on a real GGUF the tensor payload
    // dwarfs the metadata block and bytesRead would be a tiny fraction.
    expect(s.bytesRead).toBeLessThanOrEqual(blob.byteLength);
  });

  it('flags chatTemplateMissing when the metadata key is absent', () => {
    const blob = new GgufBuilder()
      .header(3, 0n)
      .metaString('general.architecture', 'gemma3')
      .metaU32('gemma3.context_length', 8192)
      .finish();
    const path = join(dir, 'no-template.gguf');
    writeFileSync(path, blob);

    const s = readGgufSummary(path);
    expect(s.chatTemplate).toBeUndefined();
    expect(s.chatTemplateMissing).toBe(true);
    expect(s.architecture).toBe('gemma3');
    expect(s.contextLength).toBe(8192n);
  });

  it('skips array-typed metadata (e.g. tokenizer vocab) without breaking', () => {
    // Tokenizer vocabs in real GGUFs are 50K+ entries — the parser
    // must skip them rather than materialise. Synthetic 5-entry array
    // is enough to exercise the type=ARRAY code path.
    const blob = new GgufBuilder()
      .header(3, 0n)
      .metaString('general.architecture', 'llama')
      .metaStringArray('tokenizer.ggml.tokens', ['<|endoftext|>', 'a', 'b', 'c', 'd'])
      .metaU32('llama.context_length', 4096)
      .finish();
    const path = join(dir, 'with-array.gguf');
    writeFileSync(path, blob);

    const s = readGgufSummary(path);
    expect(s.architecture).toBe('llama');
    expect(s.contextLength).toBe(4096n);
  });

  it('rejects a non-GGUF file', () => {
    const path = join(dir, 'not-gguf.bin');
    writeFileSync(path, Buffer.from('NOPE\x00\x00\x00\x00', 'binary'));
    expect(() => readGgufSummary(path)).toThrow(/not a GGUF file/);
  });

  it('rejects an unsupported version', () => {
    const blob = new GgufBuilder().header(99, 0n).finish();
    const path = join(dir, 'bad-version.gguf');
    writeFileSync(path, blob);
    expect(() => readGgufSummary(path)).toThrow(/unsupported GGUF version/);
  });

  it('reports the underlying file_type number when the lookup table misses', () => {
    const blob = new GgufBuilder()
      .header(3, 0n)
      .metaString('general.architecture', 'imagined')
      .metaU32('general.file_type', 999)
      .finish();
    const path = join(dir, 'unknown-type.gguf');
    writeFileSync(path, blob);

    const s = readGgufSummary(path);
    expect(s.fileType).toBe(999);
    expect(s.fileTypeName).toBe('UNKNOWN_999');
  });
});
