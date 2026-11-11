/**
 * Where a model the catalog does not carry comes from: a Hugging Face model
 * repository, optionally narrowed to one GGUF file, quant tag, or revision.
 *
 * Every string here may come from a web page (the Hugging Face "Use this
 * model" button sends a `gezel://` link) or from text a person pasted, so the
 * grammar is strict and anything outside it is refused rather than repaired.
 * A reference only names a model; reviewing and downloading it are separate
 * steps the person confirms.
 */

/** A model repository on the Hugging Face Hub, possibly narrowed to one file. */
export interface HuggingFaceModelReference {
  /** `owner/name`, as the Hub spells it. */
  repo: string;
  /** Repo-relative path of one `.gguf` file (any shard of a split model). */
  file?: string;
  /** Quant tag from an `owner/name:Q4_K_M` reference (the `llama -hf` form). */
  quant?: string;
  /** Branch, tag, or commit named by a `/blob/<rev>/…` or `/tree/<rev>` URL. */
  revision?: string;
}

const REPO_PART = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
const QUANT_TAG = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const FILE_SEGMENT = /^[A-Za-z0-9_+()[\]][A-Za-z0-9_.+()[\] -]{0,199}$/;
/** Longer than any real Hub path; a longer one is someone probing. */
export const MAX_MODEL_FILE_PATH_LENGTH = 512;
const HUB_HOSTS = new Set(['huggingface.co', 'www.huggingface.co', 'hf.co']);

/** `owner/name` with the Hub's own character set. */
export function isHuggingFaceRepoId(value: string): boolean {
  const parts = value.split('/');
  if (parts.length !== 2) return false;
  const [owner, name] = parts as [string, string];
  if (!REPO_PART.test(owner) || !REPO_PART.test(name)) return false;
  return !owner.includes('..') && !name.includes('..');
}

/**
 * A repo-relative path that can only name a file inside the repo: no
 * absolute paths, no `.`/`..` segments, no backslashes, a bounded length, and
 * a `.gguf` ending.
 */
export function isSafeGgufRepoPath(value: string): boolean {
  if (!value || value.length > MAX_MODEL_FILE_PATH_LENGTH) return false;
  if (!value.toLowerCase().endsWith('.gguf')) return false;
  const segments = value.split('/');
  return segments.every(
    (segment) => segment !== '.' && segment !== '..' && FILE_SEGMENT.test(segment),
  );
}

export function isSafeHubRevision(value: string): boolean {
  return REVISION.test(value);
}

/** A 40-character commit id: the only revision a download is ever pinned to. */
export function isHubCommitId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function withRepoTag(text: string): HuggingFaceModelReference | null {
  const colon = text.lastIndexOf(':');
  const repo = colon > 0 ? text.slice(0, colon) : text;
  const quant = colon > 0 ? text.slice(colon + 1) : undefined;
  if (!isHuggingFaceRepoId(repo)) return null;
  if (quant !== undefined && !QUANT_TAG.test(quant)) return null;
  return quant ? { repo, quant } : { repo };
}

function fromHubPath(segments: string[]): HuggingFaceModelReference | null {
  // Datasets and Spaces share the host; neither holds a model to run.
  if (segments[0] === 'datasets' || segments[0] === 'spaces') return null;
  if (segments.length < 2) return null;
  const owner = segments[0] as string;
  const nameWithTag = segments[1] as string;
  if (segments.length === 2) return withRepoTag(`${owner}/${nameWithTag}`);
  const repo = `${owner}/${nameWithTag}`;
  if (!isHuggingFaceRepoId(repo)) return null;
  const view = segments[2];
  const revision = segments[3];
  if (view === 'tree') {
    if (!revision) return { repo };
    return isSafeHubRevision(revision) ? { repo, revision } : null;
  }
  if (view === 'blob' || view === 'resolve') {
    if (!revision || !isSafeHubRevision(revision)) return null;
    const file = segments.slice(4).join('/');
    if (!isSafeGgufRepoPath(file)) return null;
    return { repo, revision, file };
  }
  // `/discussions`, `/commits`, model-card anchors: the repo is still clear.
  return { repo };
}

/**
 * Read what a person pasted, or what the Hub's button sent, into a model
 * reference. Accepted forms:
 *
 * - `owner/name`, `owner/name:Q4_K_M`
 * - `hf.co/owner/name[:quant]`, `huggingface.co/owner/name[:quant]`
 * - `https://huggingface.co/owner/name` and its `/tree/<rev>`,
 *   `/blob/<rev>/<file.gguf>` and `/resolve/<rev>/<file.gguf>` pages
 *
 * Returns null for anything else, including dataset and Space URLs and other
 * hosts.
 */
export function parseHuggingFaceReference(input: string): HuggingFaceModelReference | null {
  const text = input.trim();
  if (!text || text.length > 1024) return null;
  if (/^https?:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (!HUB_HOSTS.has(url.hostname.toLowerCase())) return null;
    let segments: string[];
    try {
      segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      return null;
    }
    return fromHubPath(segments);
  }
  const bare = text.replace(/^(?:www\.)?(?:huggingface\.co|hf\.co)\//i, '');
  if (bare !== text) return fromHubPath(bare.split('/').filter(Boolean));
  return withRepoTag(text);
}

/** The Hub page for a reference, for a "View on Hugging Face" link. */
export function huggingFaceModelUrl(repo: string, revision?: string): string {
  const base = `https://huggingface.co/${repo
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`;
  return revision && revision !== 'main' ? `${base}/tree/${encodeURIComponent(revision)}` : base;
}
