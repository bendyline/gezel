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

const TENSOR_ALIGNMENT = 32;

class GgufBuilder {
  private parts: Buffer[] = [];
  private metaCount = 0n;
  private tensors: { name: string; sizeBytes: number }[] = [];

  header(version = 3, tensorCount = 0n) {
    this.parts.push(Buffer.from('GGUF', 'ascii'));
    this.parts.push(this.u32(version));
    this.parts.push(this.u64(tensorCount));
    // metadata-count slot (8 bytes), patched in finish() once we
    // know how many entries we wrote.
    this.parts.push(this.u64(0n));
    return this;
  }

  /**
   * Declare a tensor with an exact data payload size. finish() writes the
   * info section (offsets aligned like the spec demands) and a zero-filled
   * data section to match, so offset-delta sizing has real bytes to check.
   */
  tensor(name: string, sizeBytes: number) {
    this.tensors.push({ name, sizeBytes });
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

  metaU32Array(key: string, values: number[]) {
    this.parts.push(this.gguf_string(key));
    this.parts.push(this.u32(VTYPE.ARRAY));
    this.parts.push(this.u32(VTYPE.UINT32));
    this.parts.push(this.u64(BigInt(values.length)));
    for (const v of values) this.parts.push(this.u32(v));
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
    const tensorParts: Buffer[] = [];
    let dataOffset = 0;
    const dataSpans: { offset: number; sizeBytes: number }[] = [];
    for (const t of this.tensors) {
      tensorParts.push(this.gguf_string(t.name));
      tensorParts.push(this.u32(1)); // n_dims
      tensorParts.push(this.u64(1n)); // dim[0]
      tensorParts.push(this.u32(0)); // ggml type (F32 — irrelevant to sizing)
      tensorParts.push(this.u64(BigInt(dataOffset)));
      dataSpans.push({ offset: dataOffset, sizeBytes: t.sizeBytes });
      dataOffset += Math.ceil(t.sizeBytes / TENSOR_ALIGNMENT) * TENSOR_ALIGNMENT;
    }

    const header = Buffer.concat([...this.parts, ...tensorParts]);
    header.writeBigUInt64LE(this.metaCount, 16);
    if (this.tensors.length === 0) return header;
    // Tensor-count slot sits at offset 8; only meaningful (and only
    // patched) when this builder declared real tensor infos — metadata-only
    // tests pass a synthetic count through header() untouched.
    header.writeBigUInt64LE(BigInt(this.tensors.length), 8);

    const dataStart = Math.ceil(header.byteLength / TENSOR_ALIGNMENT) * TENSOR_ALIGNMENT;
    const last = dataSpans[dataSpans.length - 1] as { offset: number; sizeBytes: number };
    const blob = Buffer.alloc(dataStart + last.offset + last.sizeBytes);
    header.copy(blob, 0);
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

  it('reads the KV-estimate attention dims', () => {
    const blob = new GgufBuilder()
      .header(3, 0n)
      .metaString('general.architecture', 'qwen3moe')
      .metaU32('qwen3moe.block_count', 48)
      .metaU32('qwen3moe.embedding_length', 4096)
      .metaU32('qwen3moe.attention.head_count', 32)
      .metaU32('qwen3moe.attention.head_count_kv', 8)
      .metaU32('qwen3moe.attention.key_length', 128)
      .metaU32('qwen3moe.attention.value_length', 128)
      .finish();
    const path = join(dir, 'kv-dims.gguf');
    writeFileSync(path, blob);

    const s = readGgufSummary(path);
    expect(s.blockCount).toBe(48);
    expect(s.embeddingLength).toBe(4096);
    expect(s.headCount).toBe(32);
    expect(s.headCountKv).toBe(8);
    expect(s.keyLength).toBe(128);
    expect(s.valueLength).toBe(128);
  });

  it('reads a per-layer head_count_kv array as its mean (Gemma 4)', () => {
    // Gemma 4 stores one KV-head count per layer. Skipping the array left
    // headCountKv undefined, the KV estimate degraded to the weights
    // heuristic, and a ~105 GB full-attention cache passed admission
    // (2026-08-05 gemma4-31b Metal OOM). The mean × block_count keeps the
    // aggregate KV total exact.
    const blob = new GgufBuilder()
      .header(3, 0n)
      .metaString('general.architecture', 'gemma4')
      .metaU32('gemma4.block_count', 4)
      .metaU32Array('gemma4.attention.head_count_kv', [16, 16, 8, 16])
      .metaU32('gemma4.attention.key_length', 512)
      .metaU32('gemma4.attention.value_length', 512)
      .finish();
    const path = join(dir, 'kv-dims-array.gguf');
    writeFileSync(path, blob);

    const s = readGgufSummary(path);
    expect(s.headCountKv).toBe(14);
    expect(s.keyLength).toBe(512);
  });
});

describe('readGgufSummary — tensor sizing (includeTensorSizes)', () => {
  it('splits expert vs non-expert bytes and sums experts per layer', () => {
    // Sizes are multiples of the 32-byte alignment so offset-delta sizing
    // is exact, matching how real GGUFs pack quantized blocks.
    const blob = new GgufBuilder()
      .header(3)
      .metaString('general.architecture', 'mixtral-ish')
      .metaU32('mixtral-ish.expert_count', 8)
      .metaU32('mixtral-ish.block_count', 2)
      .tensor('token_embd.weight', 1024)
      .tensor('blk.0.attn_q.weight', 2048)
      .tensor('blk.0.ffn_gate_exps.weight', 4096)
      .tensor('blk.0.ffn_up_exps.weight', 4096)
      .tensor('blk.1.ffn_down_exps.weight', 8192)
      .tensor('blk.1.ffn_gate_shexp.weight', 512)
      .tensor('output.weight', 1024)
      .finish();
    const path = join(dir, 'moe-tensors.gguf');
    writeFileSync(path, blob);

    const s = readGgufSummary(path, { includeTensorSizes: true });
    // Routed experts only — the shared expert (`_shexp`) stays GPU-resident
    // under --cpu-moe and must count as non-expert.
    expect(s.expertBytesTotal).toBe(4096 + 4096 + 8192);
    expect(s.nonExpertBytes).toBe(1024 + 2048 + 512 + 1024);
    expect(s.expertBytesByLayer).toEqual([8192, 8192]);
  });

  it('reports zero expert bytes for a dense model', () => {
    const blob = new GgufBuilder()
      .header(3)
      .metaString('general.architecture', 'llama')
      .tensor('token_embd.weight', 1024)
      .tensor('blk.0.attn_q.weight', 2048)
      .tensor('blk.0.ffn_gate.weight', 4096)
      .finish();
    const path = join(dir, 'dense-tensors.gguf');
    writeFileSync(path, blob);

    const s = readGgufSummary(path, { includeTensorSizes: true });
    expect(s.expertBytesTotal).toBe(0);
    expect(s.nonExpertBytes).toBe(1024 + 2048 + 4096);
    expect(s.expertBytesByLayer).toEqual([]);
  });

  it('leaves sizing fields unset when not asked for them', () => {
    const blob = new GgufBuilder()
      .header(3)
      .metaString('general.architecture', 'llama')
      .tensor('blk.0.ffn_gate_exps.weight', 4096)
      .finish();
    const path = join(dir, 'unsized.gguf');
    writeFileSync(path, blob);

    const s = readGgufSummary(path, { includeTensors: true });
    expect(s.tensorNames).toEqual(['blk.0.ffn_gate_exps.weight']);
    expect(s.expertBytesTotal).toBeUndefined();
    expect(s.nonExpertBytes).toBeUndefined();
    expect(s.expertBytesByLayer).toBeUndefined();
  });
});
