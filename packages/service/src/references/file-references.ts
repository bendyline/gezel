import { type ReferencedFile, type ReferencedFileKind, normalizeFileToken } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';

/**
 * Find which of a project's real files an assistant reply mentioned in its
 * body markdown. Used as a backstop when the active provider hides tool
 * calls (Copilot's SDK does) and as futureproofing for AI that writes files
 * outside the MCP tool path.
 *
 * Runs at message-persist time in ChatManager, and again in the timeline
 * read path for messages that predate the parser.
 *
 * Two properties are load-bearing:
 *
 *   - **The scan is linear in the message, not in the inventory.** An
 *     earlier version ran one regex per inventory entry per message. That
 *     was fine against a few dozen artifacts and quadratic against a
 *     workspace, which the indexer caps at 20k files — 20k regex
 *     executions per bubble on every timeline load. Here the message is
 *     tokenized once and each token is a hash lookup.
 *   - **Only the inventory decides what is a file.** The tokenizer is
 *     deliberately greedy; every false candidate it produces dies at the
 *     map lookup. That is what lets it scan prose and fenced code without
 *     a separate confidence tier per pass.
 */

/** Artifacts win ties, so a path present in both stores keeps its historical kind. */
const KIND_ORDER: ReadonlyArray<{ kind: ReferencedFileKind; key: keyof FileInventory }> = [
  { kind: 'artifact', key: 'artifacts' },
  { kind: 'workspace', key: 'workspace' },
];

function kindRank(kind: ReferencedFileKind): number {
  return KIND_ORDER.findIndex((entry) => entry.kind === kind);
}

/**
 * A single reply naming hundreds of files is a report, not a reference —
 * capping keeps the chip row, the session file, and the rail's MRU sane.
 * Hit only by machine-generated inventories; ordinary replies name a handful.
 */
const MAX_REFERENCED_FILES = 50;

/**
 * URL-ish spans are removed before tokenizing. Without this a GitHub blob
 * link (`…/blob/main/docs/API.md`) reads as a reference to the local
 * `docs/API.md`, which is exactly the false positive that makes users stop
 * trusting the chips.
 */
const URL_SPAN_RE = /\b(?:https?|ftp|file|data|mailto):[^\s<>()[\]{}"'`]*/gi;

/**
 * A path-ish run, plus an optional trailing source locator. The locator
 * branch is what makes `image.ts:84,230` and `useFrameCapture.ts#L1633`
 * resolve to their files instead of missing entirely — models writing
 * review prose cite lines far more often than they cite bare paths.
 */
const PATH_TOKEN_RE = /[A-Za-z0-9_~@][A-Za-z0-9_.+/@-]*(?:[:#][A-Za-z0-9,:-]*[0-9])?/g;

export interface FileInventory {
  /** Artifacts-drawer-relative paths. */
  artifacts?: readonly string[];
  /** Workspace-root-relative paths. */
  workspace?: readonly string[];
}

/**
 * Resolved lookup tables for one project's inventory. Build it once per
 * project and reuse it across every message in scope — {@link
 * matchReferencedFilesInContent} builds one per call, which is right for a
 * single turn and wrong for a timeline page.
 */
export interface FileInventoryIndex {
  readonly size: number;
  readonly byFullPath: ReadonlyMap<string, ReferencedFile>;
  /** Ambiguous basenames map to `null` — we cannot guess which file was meant. */
  readonly byBasename: ReadonlyMap<string, ReferencedFile | null>;
}

export function buildFileInventoryIndex(inventory: FileInventory): FileInventoryIndex {
  const byFullPath = new Map<string, ReferencedFile>();
  const byBasename = new Map<string, ReferencedFile | null>();
  for (const { kind, key } of KIND_ORDER) {
    for (const raw of inventory[key] ?? []) {
      const path = raw.replace(/^\.?\/+/, '');
      if (!path) continue;
      const lower = path.toLowerCase();
      if (byFullPath.has(lower)) continue;
      const entry: ReferencedFile = { kind, path };
      byFullPath.set(lower, entry);
      const base = lower.slice(lower.lastIndexOf('/') + 1);
      // `has` rather than truthiness: a basename already knocked out as
      // ambiguous must stay knocked out when a third file claims it.
      byBasename.set(base, byBasename.has(base) ? null : entry);
    }
  }
  return { size: byFullPath.size, byFullPath, byBasename };
}

export function matchReferencedFilesInContent(
  content: string,
  inventory: FileInventory,
): ReferencedFile[] {
  return matchReferencedFilesWithIndex(content, buildFileInventoryIndex(inventory));
}

export function matchReferencedFilesWithIndex(
  content: string,
  index: FileInventoryIndex,
): ReferencedFile[] {
  if (!content || index.size === 0) return [];
  const hits = new Map<string, ReferencedFile>();
  for (const token of scanPathTokens(content)) {
    const hit = resolveToken(token, index);
    if (!hit) continue;
    hits.set(`${hit.kind}:${hit.path}`, hit);
    if (hits.size >= MAX_REFERENCED_FILES) break;
  }
  // Deterministic order — artifacts first, path-sorted within a kind — so
  // persisted rows and the legacy projection stay stable across runs.
  return [...hits.values()].sort(
    (a, b) => kindRank(a.kind) - kindRank(b.kind) || (a.path < b.path ? -1 : 1),
  );
}

/** The artifact-only projection persisted for older clients. */
export function artifactPathsOf(files: readonly ReferencedFile[]): string[] {
  return files.filter((f) => f.kind === 'artifact').map((f) => f.path);
}

/** Widen a legacy `referencedArtifacts` list into the current shape. */
export function referencedFilesFromArtifactPaths(paths: readonly string[]): ReferencedFile[] {
  return paths.map((path) => ({ kind: 'artifact' as const, path }));
}

export async function extractReferencedFiles(
  store: Store,
  projectId: string,
  content: string,
  opts: { workspaceFiles?: readonly string[] } = {},
): Promise<ReferencedFile[]> {
  if (!content) return [];
  const files = await store.listProjectArtifactsRecursive(projectId);
  return matchReferencedFilesInContent(content, {
    // `ProjectFileEntry` — keep only leaf files, strip directory walks.
    artifacts: files.filter((f) => !f.isDirectory).map((f) => f.path),
    ...(opts.workspaceFiles ? { workspace: opts.workspaceFiles } : {}),
  });
}

interface PathToken {
  /** The path part, locator and surrounding punctuation removed. */
  path: string;
  /** True when the token carried a `/` — full-path match only. */
  qualified: boolean;
  /** True when the final segment has an extension. */
  extended: boolean;
}

/**
 * Pull every path-ish token out of the message. Runs against the full
 * content — fenced blocks included, because a filename the model dropped
 * into a shell snippet is still a reference the user wants to click.
 */
export function scanPathTokens(content: string): PathToken[] {
  const out: PathToken[] = [];
  const scrubbed = content.replace(URL_SPAN_RE, ' ');
  for (const match of scrubbed.matchAll(PATH_TOKEN_RE)) {
    const token = normalizeToken(match[0]);
    if (token) out.push(token);
  }
  return out;
}

/**
 * Detect the historical resolver bug where a qualified missing path such as
 * `powerpoint/task-11/deck.pptx` fell back to a same-basename file at the
 * project root. Timeline reads use this to repair already-persisted reference
 * metadata against the current inventory without re-indexing every message.
 */
export function hasQualifiedReferenceMismatch(
  content: string,
  references: readonly ReferencedFile[],
): boolean {
  if (references.length === 0) return false;
  const referencedPaths = new Set(references.map((file) => file.path.toLowerCase()));
  const referencedBasenames = new Set(
    references.map((file) => file.path.toLowerCase().slice(file.path.lastIndexOf('/') + 1)),
  );
  return scanPathTokens(content).some((token) => {
    if (!token.qualified) return false;
    const lower = token.path.toLowerCase();
    if (referencedPaths.has(lower)) return false;
    return referencedBasenames.has(lower.slice(lower.lastIndexOf('/') + 1));
  });
}

function normalizeToken(raw: string): PathToken | null {
  const s = normalizeFileToken(raw);
  if (!s || s.length > 512) return null;
  const lastSlash = s.lastIndexOf('/');
  const basename = s.slice(lastSlash + 1);
  if (!basename) return null;
  return { path: s, qualified: lastSlash >= 0, extended: basename.includes('.') };
}

function resolveToken(token: PathToken, index: FileInventoryIndex): ReferencedFile | null {
  const lower = token.path.toLowerCase();
  // A qualified mention is an exact claim. Falling back to its basename can
  // silently turn `task-11/deck.pptx` into the unrelated `deck.pptx` at the
  // project root. Bare names may use the basename index, whose `null` entries
  // preserve ambiguity when more than one real file shares the name.
  const hit = token.qualified ? index.byFullPath.get(lower) : index.byBasename.get(lower);
  if (!hit) return null;
  // A token with neither a slash nor an extension is an ordinary English
  // word until proven otherwise. Let one match the small, gezel-produced
  // artifacts drawer (where `Dockerfile` really is what was meant) but
  // never a workspace of thousands, where "review" or "changes" hitting a
  // real extension-less file is overwhelmingly a false positive.
  if (!token.extended && !token.qualified && hit.kind !== 'artifact') return null;
  return hit;
}
