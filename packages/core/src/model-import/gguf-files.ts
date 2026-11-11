/**
 * A Hugging Face GGUF repository usually holds one model in many sizes: a
 * file per quantization, large quants split into `-00001-of-0000N` shards,
 * often a vision projector (`mmproj-*.gguf`), sometimes an importance matrix.
 * This groups that listing into the choices a person can make.
 */

/** One file in a repository listing at a pinned commit. */
export interface HubRepoFile {
  path: string;
  sizeBytes: number;
  /** SHA-256 of the file's bytes, when the Hub stored it in LFS. */
  sha256?: string;
}

/** One downloadable model: a single GGUF, or every shard of a split one. */
export interface GgufChoice {
  /** The first file's path; what a choice is selected by. */
  key: string;
  /** Files in load order (shard 1 first). */
  files: HubRepoFile[];
  /** Quant tag read from the filename (`Q4_K_M`, `UD-Q4_K_XL`, `BF16`), when there is one. */
  quant?: string;
  sizeBytes: number;
}

export interface GgufRepoLayout {
  choices: GgufChoice[];
  /** Multimodal projectors that sit beside the model. */
  projectors: HubRepoFile[];
  /** Split models with a shard missing from the listing; never offered. */
  incompleteSplits: string[];
}

const SHARD = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;

/**
 * Quant labels as uploaders write them, last match in the filename wins:
 * `Qwen3-8B-Q4_K_M.gguf`, `gemma-3-4b-it-qat-q4_0.gguf`,
 * `Model-UD-Q4_K_XL.gguf`, `model-bf16.gguf`, `gpt-oss-20b-mxfp4.gguf`.
 */
const QUANT_LABEL =
  /(?:^|[-._])((?:UD-)?(?:I?Q[1-8](?:_[A-Z0-9]{1,4}){0,2}|BF16|F16|F32|MXFP4(?:_MOE)?|NVFP4|TQ[12]_0))(?=[-._]|$)/gi;

const SHARD_SUFFIX = /-\d{5}-of-\d{5}$/i;

export function ggufQuantFromFilename(path: string): string | undefined {
  const base = (path.split('/').pop() ?? path).replace(/\.gguf$/i, '').replace(SHARD_SUFFIX, '');
  let last: string | undefined;
  for (const match of base.matchAll(QUANT_LABEL)) last = match[1];
  return last?.toUpperCase();
}

function isProjector(path: string): boolean {
  const base = (path.split('/').pop() ?? path).toLowerCase();
  return base.includes('mmproj');
}

function isNonModelGguf(path: string): boolean {
  const base = (path.split('/').pop() ?? path).toLowerCase();
  // llama.cpp now stores importance matrices as GGUF; they are quantization
  // inputs, not models. EAGLE and DFlash files are speculative-decoding
  // drafters that ride beside a model (ggml-org/gpt-oss-20b-GGUF ships two).
  return base.includes('imatrix') || base.includes('eagle') || base.includes('dflash');
}

export function layoutGgufRepo(files: readonly HubRepoFile[]): GgufRepoLayout {
  const singles: GgufChoice[] = [];
  const projectors: HubRepoFile[] = [];
  const splits = new Map<string, { total: number; parts: Map<number, HubRepoFile> }>();
  for (const file of files) {
    if (!file.path.toLowerCase().endsWith('.gguf')) continue;
    if (isNonModelGguf(file.path)) continue;
    if (isProjector(file.path)) {
      projectors.push(file);
      continue;
    }
    const shard = SHARD.exec(file.path);
    if (!shard) {
      singles.push({
        key: file.path,
        files: [file],
        sizeBytes: file.sizeBytes,
        ...optionalQuant(file.path),
      });
      continue;
    }
    const prefix = shard[1] as string;
    const index = Number(shard[2]);
    const total = Number(shard[3]);
    const id = `${prefix}::${total}`;
    const entry = splits.get(id) ?? { total, parts: new Map<number, HubRepoFile>() };
    entry.parts.set(index, file);
    splits.set(id, entry);
  }
  const choices = [...singles];
  const incompleteSplits: string[] = [];
  for (const [id, split] of splits) {
    const ordered: HubRepoFile[] = [];
    for (let i = 1; i <= split.total; i++) {
      const part = split.parts.get(i);
      if (!part) break;
      ordered.push(part);
    }
    if (ordered.length !== split.total || split.total < 2) {
      incompleteSplits.push(id.split('::')[0] as string);
      continue;
    }
    const first = ordered[0] as HubRepoFile;
    choices.push({
      key: first.path,
      files: ordered,
      sizeBytes: ordered.reduce((sum, part) => sum + part.sizeBytes, 0),
      ...optionalQuant(first.path),
    });
  }
  choices.sort((a, b) => a.sizeBytes - b.sizeBytes || a.key.localeCompare(b.key));
  return { choices, projectors, incompleteSplits };
}

function optionalQuant(path: string): { quant?: string } {
  const quant = ggufQuantFromFilename(path);
  return quant ? { quant } : {};
}

/** The choice that holds `path`, whether it names the first shard or any other. */
export function ggufChoiceForFile(layout: GgufRepoLayout, path: string): GgufChoice | undefined {
  return layout.choices.find((choice) => choice.files.some((file) => file.path === path));
}

/**
 * The quant a person would pick without knowing the alphabet soup: a 4-bit
 * K-quant first (the size/quality balance most uploaders recommend), then
 * the nearby 4-bit formats, then larger, then smaller.
 */
export const GGUF_QUANT_PREFERENCE: readonly string[] = [
  'Q4_K_M',
  'UD-Q4_K_XL',
  'Q4_K_L',
  'Q4_K_S',
  'IQ4_XS',
  'IQ4_NL',
  'MXFP4_MOE',
  'MXFP4',
  'Q4_0',
  'Q5_K_M',
  'UD-Q5_K_XL',
  'Q5_K_S',
  'Q6_K',
  'UD-Q3_K_XL',
  'Q3_K_M',
  'Q3_K_L',
  'IQ3_M',
  'Q8_0',
  'Q3_K_S',
  'IQ3_XS',
  'UD-Q2_K_XL',
  'Q2_K',
  'BF16',
  'F16',
];

function preferenceRank(choice: GgufChoice): number {
  const rank = choice.quant ? GGUF_QUANT_PREFERENCE.indexOf(choice.quant) : -1;
  return rank < 0 ? GGUF_QUANT_PREFERENCE.length : rank;
}

/**
 * The choice a review opens on. An explicit file or quant wins when the repo
 * has it. Otherwise the most preferred quant that `fits` accepts; when none
 * does, the smallest choice, so the review shows the closest thing to
 * runnable rather than the best thing that cannot load.
 */
export function pickGgufChoice(
  layout: GgufRepoLayout,
  opts: { file?: string; quant?: string; fits?: (choice: GgufChoice) => boolean } = {},
): GgufChoice | undefined {
  if (opts.file) {
    const byFile = ggufChoiceForFile(layout, opts.file);
    if (byFile) return byFile;
  }
  if (opts.quant) {
    const wanted = opts.quant.toUpperCase();
    const byQuant = layout.choices.find((choice) => choice.quant === wanted);
    if (byQuant) return byQuant;
  }
  const ranked = [...layout.choices].sort(
    (a, b) => preferenceRank(a) - preferenceRank(b) || a.sizeBytes - b.sizeBytes,
  );
  const fits = opts.fits;
  if (fits) {
    const best = ranked.find((choice) => fits(choice));
    if (best) return best;
    return layout.choices[0];
  }
  return ranked[0];
}

/**
 * The projector to pair with a model when the repo ships several (one per
 * precision): F16 when offered, it is what llama.cpp's own conversions
 * publish and what every quant of the model was tested against; else the
 * smallest.
 */
export function pickGgufProjector(projectors: readonly HubRepoFile[]): HubRepoFile | undefined {
  if (projectors.length === 0) return undefined;
  const f16 = projectors.find((file) => /(?:^|[-._])f16(?=[-._]|$)/i.test(file.path));
  if (f16) return f16;
  return [...projectors].sort((a, b) => a.sizeBytes - b.sizeBytes)[0];
}
