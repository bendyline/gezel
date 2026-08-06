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
   * `<arch>.attention.head_count_kv` — KV heads (GQA). Archs that store a
   * per-layer array here (Gemma 4) yield the array MEAN, possibly
   * fractional — the KV estimate multiplies by `block_count`, so the mean
   * keeps the aggregate exact. See readUintScalarOrArrayDetail for why
   * "degrade to unavailable" was the wrong policy.
   */
  headCountKv?: number;
  /**
   * The raw per-layer `head_count_kv` array when the arch stores one
   * (Gemma 4) — index-aligned with `slidingWindowPattern`, which is what
   * makes the windowed-KV estimate exact: Gemma 4's global layers carry
   * DIFFERENT head counts than its SWA layers (31b: 4 vs 16), so a mean
   * cannot price the two cache shapes. Absent for scalar-headed archs.
   */
  headCountKvPerLayer?: number[];
  /** `<arch>.attention.key_length` — per-head K dim when it differs from embd/heads. */
  keyLength?: number;
  /** `<arch>.attention.value_length` — per-head V dim when it differs from embd/heads. */
  valueLength?: number;
  /**
   * `<arch>.attention.sliding_window` — SWA window size in tokens.
   * `> 0` marks the model as sliding-window-attention; layers listed
   * `true` in `slidingWindowPattern` cache only ~this many tokens under
   * the default (windowed) KV cache.
   */
  slidingWindow?: number;
  /**
   * `<arch>.attention.sliding_window_pattern` — one flag per layer,
   * `true` = SWA (window-capped cache), `false` = global attention
   * (full-context cache). Gemma 4 ships 5:1. Input to
   * `estimateWindowedKvLinearization`; absent on non-SWA archs and on
   * GGUFs that predate the key.
   */
  slidingWindowPattern?: boolean[];
  /** `<arch>.attention.key_length_swa` — per-head K dim on SWA layers when it differs (Gemma 4: 256 vs 512). */
  keyLengthSwa?: number;
  /** `<arch>.attention.value_length_swa` — per-head V dim on SWA layers when it differs. */
  valueLengthSwa?: number;
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
  /** Physical read(2) calls made by the buffered reader. A large tokenizer
   *  vocabulary should cost tens of reads, not one syscall per token. */
  readOperations: number;
}

// Small buffered reader over a file descriptor. Tokenizer vocabularies can
// contain hundreds of thousands of strings. Reading each 8-byte length with a
// separate readSync pinned Electron's main thread for minutes when Settings
// previewed context sizing. One bounded read-ahead window turns that syscall
// storm into sequential I/O, while skip() avoids reading ignored payloads.
const READ_AHEAD_BYTES = 256 * 1024;

class Reader {
  private pos = 0;
  private bytesRead = 0;
  private readOperations = 0;
  private readonly readAhead = Buffer.allocUnsafe(READ_AHEAD_BYTES);
  private readAheadStart = -1;
  private readAheadEnd = -1;
  private fd: number;
  private fileSize: number;

  constructor(fd: number, fileSize: number) {
    this.fd = fd;
    this.fileSize = fileSize;
  }

  bytes(n: number): Buffer {
    this.assertRange(n);
    if (n === 0) return Buffer.alloc(0);

    if (
      n <= this.readAhead.length &&
      this.pos >= this.readAheadStart &&
      this.pos + n <= this.readAheadEnd
    ) {
      const offset = this.pos - this.readAheadStart;
      this.pos += n;
      return this.readAhead.subarray(offset, offset + n);
    }

    if (n <= this.readAhead.length) {
      const available = Math.min(this.readAhead.length, this.fileSize - this.pos);
      const got = readSync(this.fd, this.readAhead, 0, available, this.pos);
      this.readOperations++;
      this.bytesRead += got;
      if (got < n) throw new Error(`unexpected EOF at offset ${this.pos + got}`);
      this.readAheadStart = this.pos;
      this.readAheadEnd = this.pos + got;
      this.pos += n;
      return this.readAhead.subarray(0, n);
    }

    // Large values we intentionally retain (notably chat templates) bypass
    // the read-ahead window so they don't require an equally large permanent
    // buffer. Ignored strings take skipString() and never land here.
    const buf = Buffer.allocUnsafe(n);
    let total = 0;
    while (total < n) {
      const got = readSync(this.fd, buf, total, n - total, this.pos + total);
      this.readOperations++;
      if (got === 0) {
        throw new Error(`unexpected EOF at offset ${this.pos + total}`);
      }
      total += got;
    }
    this.pos += n;
    this.bytesRead += total;
    this.readAheadStart = -1;
    this.readAheadEnd = -1;
    return buf;
  }

  skip(n: number): void {
    this.assertRange(n);
    this.pos += n;
  }

  private assertRange(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0 || this.pos + n > this.fileSize) {
      throw new Error(`invalid GGUF read length ${n} at offset ${this.pos}`);
    }
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

  skipString(): void {
    const len = Number(this.u64());
    if (len > 16 * 1024 * 1024) {
      throw new Error(`absurdly large string length ${len} at offset ${this.pos - 8}`);
    }
    this.skip(len);
  }

  // Read a value of the given type. For ARRAY, recurse one level —
  // most of the arrays in GGUF metadata are token vocabularies which
  // we don't care about, so we skip them without materialising.
  skipValue(type: GgufValueType): void {
    switch (type) {
      case GgufValueType.UINT8:
      case GgufValueType.INT8:
      case GgufValueType.BOOL:
        this.skip(1);
        return;
      case GgufValueType.UINT16:
      case GgufValueType.INT16:
        this.skip(2);
        return;
      case GgufValueType.UINT32:
      case GgufValueType.INT32:
      case GgufValueType.FLOAT32:
        this.skip(4);
        return;
      case GgufValueType.UINT64:
      case GgufValueType.INT64:
      case GgufValueType.FLOAT64:
        this.skip(8);
        return;
      case GgufValueType.STRING:
        this.skipString();
        return;
      case GgufValueType.ARRAY: {
        const elemType = this.u32() as GgufValueType;
        const count = Number(this.u64());
        if (!Number.isSafeInteger(count) || count < 0) {
          throw new Error(`invalid GGUF array length ${count} at offset ${this.pos - 8}`);
        }
        const width = fixedWidth(elemType);
        if (width !== null) {
          this.skip(count * width);
          return;
        }
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

  totalReadOperations(): number {
    return this.readOperations;
  }

  currentPos(): number {
    return this.pos;
  }

  size(): number {
    return this.fileSize;
  }
}

function fixedWidth(type: GgufValueType): number | null {
  switch (type) {
    case GgufValueType.UINT8:
    case GgufValueType.INT8:
    case GgufValueType.BOOL:
      return 1;
    case GgufValueType.UINT16:
    case GgufValueType.INT16:
      return 2;
    case GgufValueType.UINT32:
    case GgufValueType.INT32:
    case GgufValueType.FLOAT32:
      return 4;
    case GgufValueType.UINT64:
    case GgufValueType.INT64:
    case GgufValueType.FLOAT64:
      return 8;
    default:
      return null;
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
 * Like {@link readUintScalar}, but also accepts a per-layer ARRAY,
 * returning both the MEAN (possibly fractional) and the raw values.
 * Gemma 4 stores `attention.head_count_kv` as one entry per layer; the
 * aggregate KV estimate multiplies the mean by `block_count` (keeping the
 * total exactly equal to the per-layer sum), while the windowed-KV
 * estimate needs the raw values because global and SWA layers carry
 * different head counts. Skipping arrays here is what left `headCountKv`
 * undefined and silently downgraded the RAM admission check to the
 * weights-scaled heuristic — which judged a ~33 GB full-attention KV
 * cache as fitting (2026-08-05 gemma4-31b Metal OOM under `--swa-full`).
 */
function readUintScalarOrArrayDetail(
  r: Reader,
  type: GgufValueType,
): { mean?: number; perLayer?: number[] } {
  if (type !== GgufValueType.ARRAY) {
    const v = readUintScalar(r, type);
    return v !== undefined ? { mean: v } : {};
  }
  const elemType = r.u32() as GgufValueType;
  const count = Number(r.u64());
  const values: number[] = [];
  let sum = 0;
  let readable = 0;
  for (let i = 0; i < count; i++) {
    const v = readUintScalar(r, elemType);
    if (v !== undefined) {
      values.push(v);
      sum += v;
      readable++;
    }
  }
  if (readable !== count || count === 0) return {};
  return { mean: sum / count, perLayer: values };
}

/**
 * Read a BOOL (or 0/1 integer) ARRAY — the shape of Gemma 4's
 * `attention.sliding_window_pattern`. Non-array values and arrays with
 * unreadable elements are consumed and reported as undefined, so the
 * windowed-KV estimate degrades to unavailable rather than guessing a
 * layer layout.
 */
function readBoolArray(r: Reader, type: GgufValueType): boolean[] | undefined {
  if (type !== GgufValueType.ARRAY) {
    r.skipValue(type);
    return undefined;
  }
  const elemType = r.u32() as GgufValueType;
  const count = Number(r.u64());
  const values: boolean[] = [];
  let readable = true;
  for (let i = 0; i < count; i++) {
    if (elemType === GgufValueType.BOOL || elemType === GgufValueType.UINT8) {
      values.push(r.u8() !== 0);
      continue;
    }
    // readUintScalar consumes the element either way, keeping the stream
    // in sync — never break out of this loop early.
    const v = readUintScalar(r, elemType);
    if (v === undefined) readable = false;
    else values.push(v !== 0);
  }
  return readable && values.length === count ? values : undefined;
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
      readOperations: 0,
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
        const detail = readUintScalarOrArrayDetail(r, type);
        if (detail.mean !== undefined) summary.headCountKv = detail.mean;
        if (detail.perLayer) summary.headCountKvPerLayer = detail.perLayer;
      } else if (key.endsWith('.attention.key_length')) {
        summary.keyLength = readUintScalar(r, type);
      } else if (key.endsWith('.attention.value_length')) {
        summary.valueLength = readUintScalar(r, type);
      } else if (key.endsWith('.attention.sliding_window')) {
        summary.slidingWindow = readUintScalar(r, type);
      } else if (key.endsWith('.attention.sliding_window_pattern')) {
        const pattern = readBoolArray(r, type);
        if (pattern) summary.slidingWindowPattern = pattern;
      } else if (key.endsWith('.attention.key_length_swa')) {
        summary.keyLengthSwa = readUintScalar(r, type);
      } else if (key.endsWith('.attention.value_length_swa')) {
        summary.valueLengthSwa = readUintScalar(r, type);
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
    summary.readOperations = r.totalReadOperations();
    return summary;
  } finally {
    closeSync(fd);
  }
}
