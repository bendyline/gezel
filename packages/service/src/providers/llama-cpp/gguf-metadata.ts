// Minimal GGUF header metadata reader.
//
// Reads only the metadata block at the start of the file, not the
// tensor data — enough to answer the Phase 0 questions:
//
//   1. Does this model have a `tokenizer.chat_template`? (If missing,
//      llama-server falls back silently to a Llama-2 template, which
//      is one of the footguns the research flagged.)
//   2. What's the context length?
//   3. What's the quantization (via `general.file_type`)?
//   4. What architecture string does the model declare?
//
// Spec: https://github.com/ggml-org/ggml/blob/master/docs/gguf.md
//
// Endianness: GGUF is little-endian by spec. We don't handle the
// obscure big-endian variant; upstream llama.cpp flags it separately
// and we'd punt too.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

// Matches `enum gguf_metadata_value_type` in ggml's gguf.h.
const GgufValueType = {
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
type GgufValueType = (typeof GgufValueType)[keyof typeof GgufValueType];

// `general.file_type` enum from llama.cpp/src/llama.h. Only the
// common values — the enum has ~30 entries and upstream adds more.
// Anything unrecognised is reported by number.
const FILE_TYPE_NAMES: Record<number, string> = {
  0: 'ALL_F32',
  1: 'MOSTLY_F16',
  2: 'MOSTLY_Q4_0',
  3: 'MOSTLY_Q4_1',
  7: 'MOSTLY_Q8_0',
  8: 'MOSTLY_Q5_0',
  9: 'MOSTLY_Q5_1',
  10: 'MOSTLY_Q2_K',
  11: 'MOSTLY_Q3_K_S',
  12: 'MOSTLY_Q3_K_M',
  13: 'MOSTLY_Q3_K_L',
  14: 'MOSTLY_Q4_K_S',
  15: 'MOSTLY_Q4_K_M',
  16: 'MOSTLY_Q5_K_S',
  17: 'MOSTLY_Q5_K_M',
  18: 'MOSTLY_Q6_K',
  19: 'MOSTLY_IQ2_XXS',
  20: 'MOSTLY_IQ2_XS',
  23: 'MOSTLY_IQ3_XXS',
  30: 'MOSTLY_BF16',
};

export interface GgufSummary {
  magic: string;
  version: number;
  tensorCount: bigint;
  metadataCount: bigint;
  architecture?: string;
  name?: string;
  contextLength?: bigint;
  fileType?: number;
  fileTypeName?: string;
  chatTemplate?: string;
  chatTemplateMissing: boolean;
  /**
   * `<arch>.expert_count` — number of MoE experts. `> 1` marks a
   * Mixture-of-Experts model (drives the hardware-aware offload
   * planner: big MoE on a small GPU → keep experts in system RAM).
   * Absent / `0` on dense models.
   */
  expertCount?: number;
  /** `<arch>.expert_used_count` — experts routed per token (the "active" count). */
  expertUsedCount?: number;
  /** `<arch>.block_count` — transformer layer count (bounds `--n-cpu-moe N`). */
  blockCount?: number;
  /** `<arch>.embedding_length` — hidden size (KV-cache estimate input). */
  embeddingLength?: number;
  /** `<arch>.attention.head_count` — query heads. */
  headCount?: number;
  /**
   * `<arch>.attention.head_count_kv` — KV heads (GQA). Some archs store a
   * per-layer array here; the scalar reader returns undefined for those and
   * the KV estimate degrades to unavailable rather than guessing.
   */
  headCountKv?: number;
  /** `<arch>.attention.key_length` — per-head K dim when it differs from embd/heads. */
  keyLength?: number;
  /** `<arch>.attention.value_length` — per-head V dim when it differs from embd/heads. */
  valueLength?: number;
  /**
   * `<arch>.nextn_predict_layers` — number of multi-token-prediction
   * (MTP / "nextn") layers. `> 0` means the GGUF carries an MTP head,
   * i.e. `--spec-type draft-mtp` is applicable. Absent on models whose
   * conversion stripped (or never had) MTP.
   */
  nextnPredictLayers?: number;
  /**
   * Tensor names — populated only when `readGgufSummary` is called with
   * `{ includeTensors: true }`. Lets callers detect MoE (`*_exps`) and
   * MTP (`nextn` / `eh_proj` / `shared_head`) tensors directly from the
   * weights, the ground truth when metadata is ambiguous.
   */
  tensorNames?: string[];
  /**
   * On-disk bytes of the routed-expert weights — exactly the tensors
   * llama.cpp's `--cpu-moe` override matches (`ffn_{up,down,gate}_exps`).
   * Populated with `{ includeTensorSizes: true }`. Shared experts
   * (`*_shexp`) stay GPU-resident under `--cpu-moe`, so they count as
   * non-expert here.
   */
  expertBytesTotal?: number;
  /**
   * On-disk bytes of everything `--cpu-moe` leaves on the GPU: attention,
   * dense/shared FFN, norms, embeddings, output head. The VRAM floor a
   * full-offload MoE launch cannot go below.
   */
  nonExpertBytes?: number;
  /**
   * Routed-expert bytes per transformer block, indexed by `blk.N` — the
   * exact input `--n-cpu-moe N` planning needs (N puts blocks `0..N-1`'s
   * experts on the CPU). Blocks without expert tensors (dense-start
   * hybrids) hold 0.
   */
  expertBytesByLayer?: number[];
  /** Total on-disk size of the GGUF (a resident-footprint proxy for the planner). */
  fileSizeBytes: number;
  // Read stats — for confirming we really don't have to slurp the file.
  bytesRead: number;
}

// Small streaming reader over a file descriptor. GGUF metadata size
// depends on the model but is typically <1 MB; we pre-fetch in chunks.
class Reader {
  private pos = 0;
  private bytesRead = 0;
  private fd: number;
  private fileSize: number;

  constructor(fd: number, fileSize: number) {
    this.fd = fd;
    this.fileSize = fileSize;
  }

  bytes(n: number): Buffer {
    const buf = Buffer.alloc(n);
    let total = 0;
    while (total < n) {
      const got = readSync(this.fd, buf, total, n - total, this.pos + total);
      if (got === 0) {
        throw new Error(`unexpected EOF at offset ${this.pos + total}`);
      }
      total += got;
    }
    this.pos += n;
    this.bytesRead += n;
    return buf;
  }

  u8(): number {
    return this.bytes(1).readUInt8(0);
  }
  i8(): number {
    return this.bytes(1).readInt8(0);
  }
  u16(): number {
    return this.bytes(2).readUInt16LE(0);
  }
  i16(): number {
    return this.bytes(2).readInt16LE(0);
  }
  u32(): number {
    return this.bytes(4).readUInt32LE(0);
  }
  i32(): number {
    return this.bytes(4).readInt32LE(0);
  }
  f32(): number {
    return this.bytes(4).readFloatLE(0);
  }
  u64(): bigint {
    return this.bytes(8).readBigUInt64LE(0);
  }
  i64(): bigint {
    return this.bytes(8).readBigInt64LE(0);
  }
  f64(): number {
    return this.bytes(8).readDoubleLE(0);
  }
  bool(): boolean {
    return this.u8() !== 0;
  }

  string(): string {
    const len = Number(this.u64());
    if (len > 16 * 1024 * 1024) {
      // GGUF strings in metadata are names, templates, tokenizer
      // vocab entries — none legitimately huge. If we see 16MB we've
      // likely lost sync with the file.
      throw new Error(`absurdly large string length ${len} at offset ${this.pos - 8}`);
    }
    return this.bytes(len).toString('utf8');
  }

  // Read a value of the given type. For ARRAY, recurse one level —
  // most of the arrays in GGUF metadata are token vocabularies which
  // we don't care about, so we skip them without materialising.
  skipValue(type: GgufValueType): void {
    switch (type) {
      case GgufValueType.UINT8:
      case GgufValueType.INT8:
      case GgufValueType.BOOL:
        this.bytes(1);
        return;
      case GgufValueType.UINT16:
      case GgufValueType.INT16:
        this.bytes(2);
        return;
      case GgufValueType.UINT32:
      case GgufValueType.INT32:
      case GgufValueType.FLOAT32:
        this.bytes(4);
        return;
      case GgufValueType.UINT64:
      case GgufValueType.INT64:
      case GgufValueType.FLOAT64:
        this.bytes(8);
        return;
      case GgufValueType.STRING:
        this.string();
        return;
      case GgufValueType.ARRAY: {
        const elemType = this.u32() as GgufValueType;
        const count = Number(this.u64());
        for (let i = 0; i < count; i++) this.skipValue(elemType);
        return;
      }
      default:
        throw new Error(`unknown GGUF value type ${type} at offset ${this.pos - 4}`);
    }
  }

  totalBytesRead(): number {
    return this.bytesRead;
  }

  currentPos(): number {
    return this.pos;
  }

  size(): number {
    return this.fileSize;
  }
}

/**
 * Read a small unsigned-integer metadata scalar (expert / block counts).
 * Handles the int types GGUF uses for these keys; for anything else it
 * consumes the value (to stay in sync with the stream) and returns
 * undefined.
 */
function readUintScalar(r: Reader, type: GgufValueType): number | undefined {
  switch (type) {
    case GgufValueType.UINT32:
      return r.u32();
    case GgufValueType.INT32:
      return r.i32();
    case GgufValueType.UINT16:
      return r.u16();
    case GgufValueType.UINT64:
      return Number(r.u64());
    case GgufValueType.INT64:
      return Number(r.i64());
    default:
      r.skipValue(type);
      return undefined;
  }
}

/**
 * The tensors `--cpu-moe` / `--n-cpu-moe` keep in system RAM — mirrors
 * llama.cpp's own buffer-type override pattern (`common/arg.cpp`), so the
 * planner's byte math matches what the engine will actually place.
 */
const EXPERT_TENSOR_RE = /\.ffn_(?:up|down|gate)_exps\./;
const BLOCK_INDEX_RE = /^blk\.(\d+)\./;

/** GGUF default tensor-data alignment when `general.alignment` is absent. */
const DEFAULT_ALIGNMENT = 32;

export function readGgufSummary(
  path: string,
  opts?: { includeTensors?: boolean; includeTensorSizes?: boolean },
): GgufSummary {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    const r = new Reader(fd, stat.size);

    const magic = r.bytes(4).toString('ascii');
    if (magic !== 'GGUF') {
      throw new Error(`not a GGUF file: magic=${JSON.stringify(magic)}`);
    }
    const version = r.u32();
    if (version < 2 || version > 3) {
      // v1 had a different header shape (no 64-bit counts). v3 is
      // current. Fail loud on anything outside this range.
      throw new Error(`unsupported GGUF version ${version}`);
    }
    const tensorCount = r.u64();
    const metadataCount = r.u64();

    const summary: GgufSummary = {
      magic,
      version,
      tensorCount,
      metadataCount,
      chatTemplateMissing: true,
      fileSizeBytes: stat.size,
      bytesRead: 0,
    };

    let alignment = DEFAULT_ALIGNMENT;

    for (let i = 0n; i < metadataCount; i++) {
      const key = r.string();
      const type = r.u32() as GgufValueType;

      // Read the scalar-valued keys we care about; skip everything
      // else. For arch-qualified keys like `llama.context_length` we
      // match on the suffix since the arch prefix varies (llama,
      // gemma, qwen2, ...).
      if (key === 'general.alignment') {
        const v = readUintScalar(r, type);
        if (v !== undefined && v > 0) alignment = v;
      } else if (key === 'general.architecture' && type === GgufValueType.STRING) {
        summary.architecture = r.string();
      } else if (key === 'general.name' && type === GgufValueType.STRING) {
        summary.name = r.string();
      } else if (key === 'general.file_type' && type === GgufValueType.UINT32) {
        const ft = r.u32();
        summary.fileType = ft;
        summary.fileTypeName = FILE_TYPE_NAMES[ft] ?? `UNKNOWN_${ft}`;
      } else if (key === 'tokenizer.chat_template' && type === GgufValueType.STRING) {
        summary.chatTemplate = r.string();
        summary.chatTemplateMissing = false;
      } else if (key.endsWith('.context_length')) {
        if (type === GgufValueType.UINT32) {
          summary.contextLength = BigInt(r.u32());
        } else if (type === GgufValueType.UINT64) {
          summary.contextLength = r.u64();
        } else {
          r.skipValue(type);
        }
      } else if (key.endsWith('.nextn_predict_layers')) {
        summary.nextnPredictLayers = readUintScalar(r, type);
      } else if (key.endsWith('.expert_count')) {
        summary.expertCount = readUintScalar(r, type);
      } else if (key.endsWith('.expert_used_count')) {
        summary.expertUsedCount = readUintScalar(r, type);
      } else if (key.endsWith('.block_count')) {
        summary.blockCount = readUintScalar(r, type);
      } else if (key.endsWith('.embedding_length')) {
        summary.embeddingLength = readUintScalar(r, type);
      } else if (key.endsWith('.attention.head_count')) {
        summary.headCount = readUintScalar(r, type);
      } else if (key.endsWith('.attention.head_count_kv')) {
        summary.headCountKv = readUintScalar(r, type);
      } else if (key.endsWith('.attention.key_length')) {
        summary.keyLength = readUintScalar(r, type);
      } else if (key.endsWith('.attention.value_length')) {
        summary.valueLength = readUintScalar(r, type);
      } else {
        r.skipValue(type);
      }
    }

    // Tensor-info section follows the metadata. `includeTensors` reads
    // just the names — the ground-truth way to detect MoE (`*_exps`) and
    // MTP (`nextn`/`eh_proj`) tensors. `includeTensorSizes` additionally
    // sizes each tensor from the offset deltas: tensor data is packed in
    // offset order with only alignment padding between entries, so
    // `next.offset - this.offset` is exact to within one alignment unit
    // (≤32 B/tensor) — and needs no per-quant GGML type-size table that
    // would go stale as upstream adds formats.
    if (opts?.includeTensors || opts?.includeTensorSizes) {
      const names: string[] = [];
      const infos: { name: string; offset: number }[] = [];
      for (let i = 0n; i < tensorCount; i++) {
        const name = r.string();
        const nDims = r.u32();
        for (let d = 0; d < nDims; d++) r.u64(); // dims
        r.u32(); // ggml tensor type
        const offset = r.u64(); // data offset, relative to the data section
        names.push(name);
        if (opts?.includeTensorSizes) infos.push({ name, offset: Number(offset) });
      }
      if (opts?.includeTensors) summary.tensorNames = names;

      if (opts?.includeTensorSizes && infos.length > 0) {
        const headerEnd = r.currentPos();
        const dataStart = Math.ceil(headerEnd / alignment) * alignment;
        const dataBytes = Math.max(0, stat.size - dataStart);
        infos.sort((a, b) => a.offset - b.offset);
        let expertTotal = 0;
        let nonExpertTotal = 0;
        const byLayer: number[] = [];
        for (let i = 0; i < infos.length; i++) {
          const info = infos[i] as { name: string; offset: number };
          const end =
            i + 1 < infos.length ? (infos[i + 1] as { offset: number }).offset : dataBytes;
          const size = Math.max(0, end - info.offset);
          if (EXPERT_TENSOR_RE.test(info.name)) {
            expertTotal += size;
            const block = BLOCK_INDEX_RE.exec(info.name);
            if (block) {
              const idx = Number(block[1]);
              byLayer[idx] = (byLayer[idx] ?? 0) + size;
            }
          } else {
            nonExpertTotal += size;
          }
        }
        summary.expertBytesTotal = expertTotal;
        summary.nonExpertBytes = nonExpertTotal;
        summary.expertBytesByLayer = Array.from(byLayer, (v) => v ?? 0);
      }
    }

    summary.bytesRead = r.totalBytesRead();
    return summary;
  } finally {
    closeSync(fd);
  }
}
