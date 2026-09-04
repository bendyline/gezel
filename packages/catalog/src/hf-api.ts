/**
 * Tiny Hugging Face Hub API client used by catalog tooling.
 *
 * Scope: enough to list the files in a model or dataset repo and extract
 * their sha256 + size for manifest generation. Not a general-purpose HF SDK —
 * we don't need authentication, model cards, or downloads (the install path
 * has its own streaming downloader).
 *
 * The Hub publishes file metadata at `/api/models/<repo>/tree/<rev>`.
 * Each entry looks like:
 *
 *   {
 *     "type": "file",
 *     "path": "model-00001-of-00003.safetensors",
 *     "size": 5343268752,
 *     "oid": "0b9b0515...",                    // git blob sha
 *     "lfs": { "oid": "2689680915...", ... }, // sha256 of the LFS payload
 *   }
 *
 * The `lfs.oid` is the sha256 we want for integrity checks. Plain
 * non-LFS files (small JSONs, tokenizer configs) don't carry an
 * `lfs` block — we fall back to the git blob's `oid`, which the HF
 * client tools also accept for verification.
 */

const HF_HUB_BASE = 'https://huggingface.co';

export interface HfFileEntry {
  /** Path within the repo (e.g. `model.safetensors`, `config.json`). */
  path: string;
  /** Size in bytes (LFS-aware — points at the resolved payload, not the pointer file). */
  sizeBytes: number;
  /**
   * SHA-256 hex string we use for integrity checks. For LFS-stored
   * files this is `lfs.oid` (HF stores the sha256 there). For small
   * non-LFS files, falls back to the git blob `oid` — not a sha256
   * but stable, and the HF client tools accept it.
   */
  sha256: string;
  /** True when the sha came from `lfs.oid` (a real sha256). */
  lfsBacked: boolean;
}

/** Hub repository kind; the API path differs (`/api/models/` vs `/api/datasets/`). */
export type HfRepoType = 'model' | 'dataset';

function apiPrefix(repoType: HfRepoType | undefined): string {
  return `${HF_HUB_BASE}/api/${repoType === 'dataset' ? 'datasets' : 'models'}`;
}

export interface FetchTreeOptions {
  /** Branch / tag / commit. Defaults to `main`. */
  rev?: string;
  /** Defaults to `model`. Knowledge catalogs live in dataset repos. */
  repoType?: HfRepoType;
  /** Test seam — defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * List every file in a Hugging Face model repo at the given rev.
 * Recurses into subdirectories so deeply-nested files (rare, but
 * happens for some quants) are returned flattened with their full
 * path.
 */
export async function fetchHuggingfaceTree(
  repo: string,
  opts: FetchTreeOptions = {},
): Promise<HfFileEntry[]> {
  const rev = opts.rev ?? 'main';
  const fetchImpl = opts.fetchImpl ?? fetch;
  const out: HfFileEntry[] = [];
  await walk(repo, rev, '', out, fetchImpl, opts.repoType);
  return out;
}

/**
 * Resolve a Hugging Face repo + revision to its concrete commit SHA.
 *
 * `/api/models/<repo>/revision/<rev>` returns the repo metadata for that
 * ref, including `sha` — the 40-char commit the ref currently points at.
 * Catalog tooling calls this with `rev = 'main'` to capture the commit
 * to pin in a manifest, so downloads become content-frozen against an
 * immutable snapshot rather than the moving branch tip.
 */
export async function fetchHuggingfaceCommit(
  repo: string,
  opts: { rev?: string; repoType?: HfRepoType; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const rev = opts.rev ?? 'main';
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${apiPrefix(opts.repoType)}/${repo}/revision/${encodeURIComponent(rev)}`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`[hf] commit resolve ${url} failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { sha?: string };
  if (!body.sha || !/^[0-9a-f]{40}$/.test(body.sha)) {
    throw new Error(`[hf] commit resolve ${url} returned no valid sha (got ${String(body.sha)})`);
  }
  return body.sha;
}

interface RawTreeEntry {
  type: 'file' | 'directory';
  path: string;
  size?: number;
  oid?: string;
  lfs?: { oid?: string; size?: number };
}

async function walk(
  repo: string,
  rev: string,
  subpath: string,
  out: HfFileEntry[],
  fetchImpl: typeof fetch,
  repoType: HfRepoType | undefined,
): Promise<void> {
  const url = `${apiPrefix(repoType)}/${repo}/tree/${rev}${subpath ? `/${subpath}` : ''}`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`[hf] tree fetch ${url} failed: ${res.status} ${res.statusText}`);
  }
  const entries = (await res.json()) as RawTreeEntry[];
  for (const e of entries) {
    if (e.type === 'directory') {
      await walk(repo, rev, e.path, out, fetchImpl, repoType);
      continue;
    }
    if (e.type !== 'file') continue;
    const lfsOid = e.lfs?.oid;
    const sha256 = lfsOid ?? e.oid ?? '';
    if (!sha256) continue;
    out.push({
      path: e.path,
      sizeBytes: e.size ?? 0,
      sha256,
      lfsBacked: Boolean(lfsOid),
    });
  }
}

/**
 * Total bytes across every file in a repo's tree. Used to populate
 * `approxSizeBytes` on a chat-model manifest.
 */
export function totalSize(files: ReadonlyArray<HfFileEntry>): number {
  return files.reduce((sum, f) => sum + f.sizeBytes, 0);
}

/**
 * Filter the tree down to the files an MLX install actually needs:
 * weight shards (`*.safetensors`), the safetensors index, configs,
 * and tokenizer files. Drops `.gitattributes`, `README.md`, sample
 * images, and other repo metadata that MLX doesn't read at run time.
 */
export function selectMlxInstallFiles(files: ReadonlyArray<HfFileEntry>): HfFileEntry[] {
  const KEEP = (path: string): boolean => {
    if (/\.safetensors(\.index\.json)?$/.test(path)) return true;
    if (
      /^(?:config|generation_config|preprocessor_config|processor_config|video_preprocessor_config|tokenizer_config|special_tokens_map)\.json$/.test(
        path,
      )
    )
      return true;
    if (path === 'tokenizer.json') return true;
    if (path === 'tokenizer.model') return true;
    if (path === 'vocab.json') return true;
    if (path === 'merges.txt') return true;
    if (path === 'chat_template.jinja') return true;
    return false;
  };
  return files.filter((f) => KEEP(f.path));
}
