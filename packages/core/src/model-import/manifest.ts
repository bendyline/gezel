/**
 * A model added from outside the catalog is described to the rest of Gezel
 * exactly like a catalog model: a chat-model manifest whose source pins every
 * file's SHA-256. The installer, launch planner, tier classifier, fit badges
 * and pickers then need no second code path.
 *
 * Three sources, one shape:
 * - a Hugging Face GGUF (`llamaCpp` source pinning the reviewed commit),
 * - a Hugging Face MLX build (`mlx` source, same pins),
 * - GGUF files from this computer (`llamaCpp` source naming the files and the
 *   checksums Gezel recorded while copying them in; never downloaded again).
 *
 * The entry is written beside the weights (`.gezel-catalog-entry.json`) and
 * served by the catalog's lowest-priority source, so it can never shadow a
 * curated entry. Its settings come, in order, from a curated entry built from
 * the same base model (`tuningFrom`, resolved live by the catalog), from the
 * sampling the model's author recommends, or from the runtime's defaults.
 */

import { IdRegex } from '../schemas/catalog-id.js';
import { type ChatModelManifest, ChatModelManifestSchema } from '../schemas/catalog.js';
import { type SamplingBlock, SamplingBlockSchema } from '../schemas/model-tuning.js';
import type { GgufChoice, HubRepoFile } from './gguf-files.js';
import {
  type GgufHeaderFacts,
  approximateBitsPerWeight,
  chatTemplateSupportsTools,
  chatTemplateThinks,
  formatParameterCount,
  ggufParameterSize,
} from './gguf-header.js';
import { huggingFaceModelUrl, isHubCommitId, isHuggingFaceRepoId } from './hf-reference.js';
import { type MlxConfigFacts, isMlxDataFile, mlxQuantizationLabel } from './mlx.js';

/** Tag every entry imported from Hugging Face carries. */
export const IMPORTED_CHAT_MODEL_TAG = 'from-hugging-face';

/** Tag every entry copied in from a file on this computer carries. */
export const LOCAL_FILE_CHAT_MODEL_TAG = 'from-local-file';

/** Hugging Face imports start here, so they never collide with a curated id. */
export const IMPORTED_CHAT_MODEL_ID_PREFIX = 'hf-';

/** Local-file imports start here. */
export const LOCAL_FILE_CHAT_MODEL_ID_PREFIX = 'local-';

/**
 * The `llamaCpp.huggingfaceRepo` a local-file entry carries, because the
 * schema requires one. Never a real repo: installers refuse to fetch an
 * entry with this source (`isLocalFileChatModel`).
 */
export const LOCAL_FILE_SOURCE_REPO = 'local-file/gguf';

/** The file beside the weights that holds an imported model's entry. */
export const IMPORTED_CHAT_MODEL_ENTRY_FILE = '.gezel-catalog-entry.json';

/**
 * Thinking budget for an imported model whose conversation format has a
 * thinking channel and no donor to lend a measured one. Without one
 * llama-server lets it think without limit, which the fitness probe rightly
 * fails; 8K leaves room for real reasoning.
 */
export const IMPORTED_THINKING_BUDGET_TOKENS = 8192;

const IMPORTED_VERSION = '1.0.0';
const MAX_ID_LENGTH = 64;

/** FNV-1a, base 36: a short stable suffix that keeps two uploads of one model apart. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, '0').slice(-6);
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

function composeId(prefix: string, name: string, tag: string, hashInput: string): string {
  const hash = shortHash(hashInput);
  const tagSlug = tag ? slug(tag) : '';
  const fixed = `${prefix}--${hash}`.length + (tagSlug ? tagSlug.length + 1 : 0);
  const room = Math.max(1, MAX_ID_LENGTH - fixed);
  const trimmed =
    slug(name)
      .slice(0, room)
      .replace(/[-.]+$/, '') || 'model';
  return `${prefix}${trimmed}${tagSlug ? `-${tagSlug}` : ''}-${hash}`;
}

/**
 * `hf-<name>-<quant>-<hash>`: readable in a model table, valid as a catalog
 * id (`[a-z0-9][a-z0-9.\-:]{1,63}`), and stable for one repo and file.
 */
export function importedChatModelId(repo: string, choiceKey: string, quant?: string): string {
  const name = (repo.split('/')[1] ?? repo).replace(/[-_.]gguf$/i, '');
  return composeId(
    IMPORTED_CHAT_MODEL_ID_PREFIX,
    name,
    quant ?? '',
    `${repo.toLowerCase()}/${choiceKey}`,
  );
}

/** `local-<file name>-<hash of its checksum>`: one id per distinct file. */
export function localFileChatModelId(fileName: string, sha256: string): string {
  const name = fileName.replace(/\.gguf$/i, '').replace(/-\d{5}-of-\d{5}$/i, '');
  return composeId(LOCAL_FILE_CHAT_MODEL_ID_PREFIX, name, '', sha256);
}

export function isImportedChatModel(manifest: { tags?: readonly string[] } | undefined): boolean {
  const tags = manifest?.tags;
  return Boolean(
    tags?.includes(IMPORTED_CHAT_MODEL_TAG) || tags?.includes(LOCAL_FILE_CHAT_MODEL_TAG),
  );
}

export function isLocalFileChatModel(manifest: { tags?: readonly string[] } | undefined): boolean {
  return Boolean(manifest?.tags?.includes(LOCAL_FILE_CHAT_MODEL_TAG));
}

/** A display name from the header, else the repo or file name, with the quant appended. */
export function importedChatModelName(
  repo: string,
  header: Pick<GgufHeaderFacts, 'name'> | undefined,
  quant?: string,
): string {
  const fromHeader = header?.name?.trim();
  const base =
    fromHeader && fromHeader.length <= 80
      ? fromHeader
      : (repo.split('/').pop() ?? repo)
          .replace(/\.gguf$/i, '')
          .replace(/[-_.]gguf$/i, '')
          .replace(/[-_]+/g, ' ');
  return quant ? `${base} (${quant})` : base;
}

// ── settings ──

/**
 * The sampling a model's author recommends, from a Transformers
 * `generation_config.json`. Only plain numbers in sane ranges survive; a
 * config that turns sampling off (`do_sample: false`) recommends nothing.
 */
export function samplingFromGenerationConfig(raw: unknown): SamplingBlock | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const config = raw as Record<string, unknown>;
  if (config.do_sample === false) return undefined;
  const num = (key: string, min: number, max: number): number | undefined => {
    const value = config[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
      ? value
      : undefined;
  };
  const temperature = num('temperature', 0.01, 2);
  const topP = num('top_p', 0.01, 1);
  const topK = num('top_k', 1, 1000);
  const minP = num('min_p', 0, 1);
  const repetitionPenalty = num('repetition_penalty', 0.5, 2);
  const block = {
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined && topP < 1 ? { topP } : {}),
    ...(topK !== undefined ? { topK: Math.round(topK) } : {}),
    ...(minP !== undefined && minP > 0 ? { minP } : {}),
    ...(repetitionPenalty !== undefined && repetitionPenalty !== 1 ? { repetitionPenalty } : {}),
  };
  if (Object.keys(block).length === 0) return undefined;
  const parsed = SamplingBlockSchema.safeParse(block);
  return parsed.success ? parsed.data : undefined;
}

/**
 * `owner/name` from a base-model reference however it is written:
 * a Hub URL, `owner/name`, or the Hub's `cardData.base_model` list.
 */
export function baseModelRefs(values: readonly unknown[]): string[] {
  const out = new Map<string, string>();
  for (const value of values) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item !== 'string') continue;
      const text = item.trim().replace(/^https?:\/\/(?:www\.)?(?:huggingface\.co|hf\.co)\//i, '');
      const [owner, name] = text.split('/');
      if (owner && name && isHuggingFaceRepoId(`${owner}/${name}`)) {
        const ref = `${owner}/${name}`;
        if (!out.has(ref.toLowerCase())) out.set(ref.toLowerCase(), ref);
      }
    }
  }
  return [...out.values()];
}

function parameterBillions(size: string | undefined): number | undefined {
  const match = size ? /^(\d+(?:\.\d+)?)\s*([BM])/i.exec(size) : null;
  if (!match) return undefined;
  const value = Number(match[1]);
  return (match[2] as string).toUpperCase() === 'M' ? value / 1000 : value;
}

/**
 * The curated entry whose settings an imported model may borrow: one built
 * from the same base model (its `upstream`), of a matching size. Settings in
 * the catalog are per model, not per quant, so any upload of that model
 * shares them. Prefers an entry for the same engine.
 */
export function findTuningDonor(
  catalog: readonly ChatModelManifest[],
  baseModels: readonly string[],
  opts: { engine: 'llama-cpp' | 'mlx'; parameterSize?: string },
): ChatModelManifest | undefined {
  if (baseModels.length === 0) return undefined;
  const wanted = new Set(baseModels.map((ref) => ref.toLowerCase()));
  const ours = parameterBillions(opts.parameterSize);
  const matches = catalog.filter((manifest) => {
    if (isImportedChatModel(manifest) || !manifest.upstream) return false;
    const [ref] = baseModelRefs([manifest.upstream]);
    if (!ref || !wanted.has(ref.toLowerCase())) return false;
    const theirs = parameterBillions(manifest.parameterSize);
    return (
      ours === undefined ||
      theirs === undefined ||
      Math.abs(ours - theirs) <= Math.max(1, theirs * 0.2)
    );
  });
  const sameEngine = matches.find((manifest) =>
    opts.engine === 'mlx' ? Boolean(manifest.mlx) : Boolean(manifest.llamaCpp),
  );
  return sameEngine ?? matches[0];
}

/**
 * The imported manifest with the donor's measured settings: its style,
 * behaviors and tuning. Engine launch settings stay behind, because they
 * describe the donor's own files (its drafter, its cache types).
 */
export function applyTuningDonor(
  manifest: ChatModelManifest,
  donor: ChatModelManifest,
): ChatModelManifest {
  const { engine: _engine, ...tuning } = donor.tuning ?? {};
  const next = {
    ...manifest,
    ...(donor.style ? { style: donor.style } : {}),
    ...(donor.behaviors ? { behaviors: donor.behaviors } : {}),
    ...(Object.keys(tuning).length > 0 ? { tuning } : {}),
  };
  const parsed = ChatModelManifestSchema.safeParse(next);
  return parsed.success ? parsed.data : manifest;
}

// ── building ──

interface CommonInput {
  name: string;
  parameterSize: string;
  supportsTools: boolean;
  thinks: boolean;
  moe: boolean;
  vision: boolean;
  contextWindow?: number;
  kvBytesPerTokenF16?: number;
  kvFixedBytesF16?: number;
  license?: string;
  /** The author's recommended sampling, when known. */
  sampling?: SamplingBlock;
  approxSizeBytes: number;
  reviewedAt: string;
}

function commonManifest(
  input: CommonInput,
  extra: {
    id: string;
    tag: string;
    description: string;
    maintainer: { name: string; url?: string };
    upstream?: string;
  },
): Record<string, unknown> {
  const tuning = {
    ...(input.sampling ? { sampling: input.sampling } : {}),
    ...(input.thinks ? { reasoning: { thinkingBudget: IMPORTED_THINKING_BUDGET_TOKENS } } : {}),
  };
  const license = input.license?.trim();
  return {
    schemaVersion: 1,
    kind: 'chat-model',
    id: extra.id,
    name: input.name.slice(0, 120),
    description: extra.description,
    tags: [
      extra.tag,
      ...(input.supportsTools ? ['tools'] : []),
      ...(input.thinks ? ['thinking'] : []),
      ...(input.moe ? ['moe'] : []),
      ...(input.vision ? ['vision'] : []),
    ],
    maintainer: extra.maintainer,
    ...(license && license.length <= 120 ? { license } : {}),
    version: IMPORTED_VERSION,
    releasedAt: input.reviewedAt,
    parameterSize: input.parameterSize,
    approxSizeBytes: Math.max(1, input.approxSizeBytes),
    supportsTools: input.supportsTools,
    ...(input.contextWindow ? { contextWindow: input.contextWindow } : {}),
    ...(input.kvBytesPerTokenF16 ? { kvBytesPerTokenF16: input.kvBytesPerTokenF16 } : {}),
    ...(input.kvBytesPerTokenF16 && input.kvFixedBytesF16 !== undefined
      ? { kvFixedBytesF16: input.kvFixedBytesF16 }
      : {}),
    ...(extra.upstream ? { upstream: extra.upstream } : {}),
    category: input.vision ? 'vision' : 'general',
    ...(Object.keys(tuning).length > 0 ? { tuning } : {}),
    availableVersions: [IMPORTED_VERSION],
  };
}

function requireSha(file: HubRepoFile): string {
  if (!file.sha256 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
    throw new Error(`${file.path} has no published SHA-256`);
  }
  return file.sha256;
}

function llamaCppSource(
  repo: string,
  revision: string | undefined,
  choice: GgufChoice,
  projector: HubRepoFile | undefined,
): NonNullable<ChatModelManifest['llamaCpp']> {
  const files = choice.files;
  const first = files[0] as HubRepoFile;
  return {
    huggingfaceRepo: repo,
    ...(revision ? { revision } : {}),
    ...(files.length > 1
      ? {
          shards: files.map((file) => ({
            name: file.path,
            sha256: requireSha(file),
            sizeBytes: file.sizeBytes,
          })),
        }
      : { filename: first.path, sha256: requireSha(first) }),
    approxSizeBytes: Math.max(1, choice.sizeBytes),
    ...(choice.quant ? { quantization: choice.quant } : {}),
    ...(projector
      ? {
          mmproj: {
            filename: projector.path,
            sha256: requireSha(projector),
            sizeBytes: projector.sizeBytes,
          },
        }
      : {}),
  };
}

/** What a GGUF header says, in the shape every builder takes. */
export function ggufCommonFacts(
  header: GgufHeaderFacts,
  choice: GgufChoice,
  projector: HubRepoFile | undefined,
): Omit<CommonInput, 'name' | 'license' | 'sampling' | 'reviewedAt'> {
  const bits = approximateBitsPerWeight(choice.quant);
  return {
    parameterSize:
      ggufParameterSize(header, {
        sizeBytes: choice.sizeBytes,
        ...(bits !== undefined ? { bitsPerWeight: bits } : {}),
      }) ?? '1B',
    supportsTools: chatTemplateSupportsTools(header.chatTemplate),
    thinks: chatTemplateThinks(header.chatTemplate),
    moe: (header.expertCount ?? 0) > 1,
    vision: Boolean(projector),
    ...(header.contextLength ? { contextWindow: header.contextLength } : {}),
    ...(header.kvBytesPerTokenF16 ? { kvBytesPerTokenF16: header.kvBytesPerTokenF16 } : {}),
    ...(header.kvFixedBytesF16 !== undefined ? { kvFixedBytesF16: header.kvFixedBytesF16 } : {}),
    approxSizeBytes: choice.sizeBytes + (projector?.sizeBytes ?? 0),
  };
}

export interface ImportedChatModelInput {
  repo: string;
  /** The commit the review pinned. */
  revision: string;
  choice: GgufChoice;
  projector?: HubRepoFile;
  header: GgufHeaderFacts;
  /** Hub `cardData.license`, preferred over the header's. */
  license?: string;
  sampling?: SamplingBlock;
  /** When the review ran (ISO), recorded as the entry's release date. */
  reviewedAt: string;
}

/**
 * The manifest for one reviewed Hugging Face GGUF. Throws when a pin is
 * missing: every file must carry the SHA-256 the installer verifies against.
 */
export function buildImportedChatModelManifest(input: ImportedChatModelInput): ChatModelManifest {
  const { repo, revision, choice, projector, header } = input;
  if (!isHuggingFaceRepoId(repo)) throw new Error(`not a Hugging Face repo id: ${repo}`);
  if (!isHubCommitId(revision)) throw new Error('the revision must be a 40-character commit id');
  const owner = repo.split('/')[0] as string;
  const facts = ggufCommonFacts(header, choice, projector);
  const license = input.license ?? header.license;
  const manifest = {
    ...commonManifest(
      {
        ...facts,
        name: importedChatModelName(repo, header, choice.quant),
        ...(license ? { license } : {}),
        ...(input.sampling ? { sampling: input.sampling } : {}),
        reviewedAt: input.reviewedAt,
      },
      {
        id: importedChatModelId(repo, choice.key, choice.quant),
        tag: IMPORTED_CHAT_MODEL_TAG,
        description: `Added from Hugging Face (${repo}). Gezel has not tested this model.`,
        maintainer: { name: owner, url: huggingFaceModelUrl(owner) },
        upstream: huggingFaceModelUrl(repo),
      },
    ),
    llamaCpp: llamaCppSource(repo, revision, choice, projector),
  };
  return ChatModelManifestSchema.parse(manifest);
}

export interface LocalGgufModelInput {
  /** The file names as they arrived, with the checksums Gezel recorded. */
  choice: GgufChoice;
  projector?: HubRepoFile;
  header: GgufHeaderFacts;
  reviewedAt: string;
}

/** The manifest for GGUF files copied in from this computer. */
export function buildLocalGgufManifest(input: LocalGgufModelInput): ChatModelManifest {
  const { choice, projector, header } = input;
  const first = choice.files[0] as HubRepoFile;
  const facts = ggufCommonFacts(header, choice, projector);
  const manifest = {
    ...commonManifest(
      {
        ...facts,
        name: importedChatModelName(first.path, header, choice.quant),
        ...(header.license ? { license: header.license } : {}),
        reviewedAt: input.reviewedAt,
      },
      {
        id: localFileChatModelId(first.path, requireSha(first)),
        tag: LOCAL_FILE_CHAT_MODEL_TAG,
        description: `Added from ${first.path} on this computer. Gezel has not tested this model.`,
        maintainer: { name: header.organization?.slice(0, 80) || 'This computer' },
      },
    ),
    llamaCpp: llamaCppSource(LOCAL_FILE_SOURCE_REPO, undefined, choice, projector),
  };
  return ChatModelManifestSchema.parse(manifest);
}

export interface ImportedMlxModelInput {
  repo: string;
  revision: string;
  /** The build directory inside the repo (`''` for the root). */
  root: string;
  /** Repo-relative paths, each with a SHA-256. */
  files: HubRepoFile[];
  facts: MlxConfigFacts;
  parameterSize: string;
  license?: string;
  sampling?: SamplingBlock;
  kvBytesPerTokenF16?: number;
  kvFixedBytesF16?: number;
  reviewedAt: string;
}

/** The manifest for one reviewed MLX build. */
export function buildImportedMlxManifest(input: ImportedMlxModelInput): ChatModelManifest {
  const { repo, revision, root, files, facts } = input;
  if (!isHuggingFaceRepoId(repo)) throw new Error(`not a Hugging Face repo id: ${repo}`);
  if (!isHubCommitId(revision)) throw new Error('the revision must be a 40-character commit id');
  const prefix = root ? `${root}/` : '';
  const rel = files.map((file) => {
    const name = file.path.slice(prefix.length);
    if (!file.path.startsWith(prefix) || !isMlxDataFile(name)) {
      throw new Error(`${file.path} is not an MLX data file`);
    }
    return { name, sha256: requireSha(file), sizeBytes: Math.max(1, file.sizeBytes) };
  });
  const owner = repo.split('/')[0] as string;
  const quantization = mlxQuantizationLabel(facts);
  const approxSizeBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const name = importedChatModelName(root ? `${repo}/${root}` : repo, undefined);
  const manifest = {
    ...commonManifest(
      {
        name: `${name} (MLX)`,
        parameterSize: input.parameterSize,
        supportsTools: chatTemplateSupportsTools(facts.chatTemplate),
        thinks: chatTemplateThinks(facts.chatTemplate),
        moe: (facts.expertCount ?? 0) > 1,
        vision: facts.vision,
        ...(facts.contextLength ? { contextWindow: facts.contextLength } : {}),
        ...(input.kvBytesPerTokenF16 ? { kvBytesPerTokenF16: input.kvBytesPerTokenF16 } : {}),
        ...(input.kvFixedBytesF16 !== undefined ? { kvFixedBytesF16: input.kvFixedBytesF16 } : {}),
        ...(input.license ? { license: input.license } : {}),
        ...(input.sampling ? { sampling: input.sampling } : {}),
        approxSizeBytes,
        reviewedAt: input.reviewedAt,
      },
      {
        id: importedChatModelId(repo, root || '.', 'mlx'),
        tag: IMPORTED_CHAT_MODEL_TAG,
        description: `Added from Hugging Face (${repo}). Gezel has not tested this model.`,
        maintainer: { name: owner, url: huggingFaceModelUrl(owner) },
        upstream: huggingFaceModelUrl(repo),
      },
    ),
    mlx: {
      huggingfaceRepo: repo,
      revision,
      ...(root ? { subdir: root } : {}),
      files: rel,
      approxSizeBytes: Math.max(1, approxSizeBytes),
      quantization,
    },
  };
  return ChatModelManifestSchema.parse(manifest);
}

/** Parameters for an MLX build: from its repo name, else its size at its bit width. */
export function mlxParameterSize(repo: string, facts: MlxConfigFacts, sizeBytes: number): string {
  const name = repo.split('/').pop() ?? repo;
  const match = /(?:^|[-_])(\d+(?:\.\d+)?)[bB](?![a-zA-Z0-9])/.exec(name);
  if (match) return `${match[1]}B`;
  const bits = facts.quantizationBits ?? 16;
  return formatParameterCount((sizeBytes * 8) / (bits + 0.5));
}

// ── the entry file ──

/** What `.gezel-catalog-entry.json` holds. */
export interface ImportedChatModelEntry {
  schemaVersion: 1;
  manifest: ChatModelManifest;
  /** A curated entry whose settings this model borrows, resolved live. */
  tuningFrom?: string;
}

export function buildImportedChatModelEntry(
  manifest: ChatModelManifest,
  tuningFrom?: string,
): ImportedChatModelEntry {
  return { schemaVersion: 1, manifest, ...(tuningFrom ? { tuningFrom } : {}) };
}

/** Read an entry file back, or null. Accepts a bare manifest too. */
export function parseImportedChatModelEntry(raw: unknown): ImportedChatModelEntry | null {
  const wrapped =
    raw && typeof raw === 'object' && 'manifest' in (raw as Record<string, unknown>)
      ? (raw as { manifest: unknown; tuningFrom?: unknown })
      : { manifest: raw };
  const manifest = sanitizeImportedChatModelManifest(wrapped.manifest);
  if (!manifest) return null;
  const donor = wrapped.tuningFrom;
  const tuningFrom =
    typeof donor === 'string' &&
    IdRegex.test(donor) &&
    !donor.startsWith(IMPORTED_CHAT_MODEL_ID_PREFIX) &&
    !donor.startsWith(LOCAL_FILE_CHAT_MODEL_ID_PREFIX)
      ? donor
      : undefined;
  return buildImportedChatModelEntry(manifest, tuningFrom);
}

/**
 * Re-read a manifest into one the runtime may trust, or null.
 *
 * The file sits beside the weights in a Gezel-owned folder, but whatever is in
 * it is rebuilt from the fields an import writes, never passed through: no
 * engine flags, behaviors, styles, prompts, or sources other than the one the
 * import recorded. Borrowed settings come from the catalog at read time, never
 * from this file.
 */
export function sanitizeImportedChatModelManifest(raw: unknown): ChatModelManifest | null {
  const parsed = ChatModelManifestSchema.safeParse(raw);
  if (!parsed.success) return null;
  const m = parsed.data;
  const local = isLocalFileChatModel(m);
  if (
    local
      ? !m.id.startsWith(LOCAL_FILE_CHAT_MODEL_ID_PREFIX)
      : !m.id.startsWith(IMPORTED_CHAT_MODEL_ID_PREFIX)
  ) {
    return null;
  }
  if (!isImportedChatModel(m)) return null;

  let source: Record<string, unknown>;
  if (m.llamaCpp && !m.mlx) {
    const src = m.llamaCpp;
    if (local) {
      if (src.huggingfaceRepo !== LOCAL_FILE_SOURCE_REPO || src.revision !== undefined) return null;
    } else if (
      !src.revision ||
      !isHubCommitId(src.revision) ||
      !isHuggingFaceRepoId(src.huggingfaceRepo)
    ) {
      return null;
    }
    source = {
      llamaCpp: {
        huggingfaceRepo: src.huggingfaceRepo,
        ...(src.revision ? { revision: src.revision } : {}),
        ...(src.shards ? { shards: src.shards } : { filename: src.filename, sha256: src.sha256 }),
        approxSizeBytes: src.approxSizeBytes,
        ...(src.quantization ? { quantization: src.quantization.slice(0, 32) } : {}),
        ...(src.mmproj ? { mmproj: src.mmproj } : {}),
      },
    };
  } else if (m.mlx && !m.llamaCpp && !local) {
    const src = m.mlx;
    if (
      !src.revision ||
      !isHubCommitId(src.revision) ||
      !isHuggingFaceRepoId(src.huggingfaceRepo)
    ) {
      return null;
    }
    if (src.files.some((file) => file.name.includes('/') || !isMlxDataFile(file.name))) return null;
    source = {
      mlx: {
        huggingfaceRepo: src.huggingfaceRepo,
        revision: src.revision,
        ...(src.subdir ? { subdir: src.subdir } : {}),
        files: src.files,
        approxSizeBytes: src.approxSizeBytes,
        ...(src.quantization ? { quantization: src.quantization.slice(0, 32) } : {}),
      },
    };
  } else {
    return null;
  }

  const thinkingBudget = m.tuning?.reasoning?.thinkingBudget;
  const sampling = m.tuning?.sampling;
  const tuning = {
    ...(sampling ? { sampling } : {}),
    ...(typeof thinkingBudget === 'number'
      ? {
          reasoning: {
            thinkingBudget: Math.min(thinkingBudget, 4 * IMPORTED_THINKING_BUDGET_TOKENS),
          },
        }
      : {}),
  };
  const clean = {
    schemaVersion: 1,
    kind: 'chat-model',
    id: m.id,
    name: m.name.slice(0, 120),
    description: m.description.slice(0, 400),
    tags: m.tags.filter((tag) => /^[a-z0-9-]{1,32}$/.test(tag)).slice(0, 12),
    maintainer: m.maintainer,
    ...(m.license ? { license: m.license.slice(0, 120) } : {}),
    version: m.version,
    releasedAt: m.releasedAt,
    parameterSize: m.parameterSize,
    approxSizeBytes: m.approxSizeBytes,
    supportsTools: m.supportsTools,
    ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
    ...(m.kvBytesPerTokenF16 ? { kvBytesPerTokenF16: m.kvBytesPerTokenF16 } : {}),
    ...(m.kvFixedBytesF16 !== undefined ? { kvFixedBytesF16: m.kvFixedBytesF16 } : {}),
    ...(m.upstream ? { upstream: m.upstream } : {}),
    ...(m.category ? { category: m.category } : {}),
    ...(Object.keys(tuning).length > 0 ? { tuning } : {}),
    ...source,
    availableVersions: [m.version],
  };
  const reparsed = ChatModelManifestSchema.safeParse(clean);
  return reparsed.success ? reparsed.data : null;
}
