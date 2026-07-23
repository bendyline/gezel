import type { Store } from '../fs/store.js';

/**
 * Find which of the project's real artifact files an assistant reply
 * mentioned in its body markdown. Used as a backstop when the active
 * provider hides tool calls (Copilot's SDK does) and as futureproofing
 * for AI that writes files outside the MCP `write_artifact` path.
 *
 * Runs at message-persist time in ChatManager, and again in the timeline
 * read path for older messages that predate the parser.
 */
export async function extractReferencedArtifacts(
  store: Store,
  projectId: string,
  content: string,
): Promise<string[]> {
  if (!content || content.length === 0) return [];
  const files = await store.listProjectArtifactsRecursive(projectId);
  // `ProjectFileEntry` — keep only leaf files, strip directory walks.
  const artifactPaths = files.filter((f) => !f.isDirectory).map((f) => f.path);
  return matchReferencedArtifactsInContent(content, artifactPaths);
}

/**
 * Pure helper that takes a pre-listed artifact inventory (basenames or
 * relative paths) and returns the canonical entries the content
 * references. Exposed so code paths like the timeline read-path can
 * feed in a single inventory they've already gathered — avoids
 * re-walking the artifacts tree per message.
 */
export function matchReferencedArtifactsInContent(
  content: string,
  artifactPaths: string[],
): string[] {
  if (!content || content.length === 0) return [];
  if (artifactPaths.length === 0) return [];
  return matchCandidatesAgainstArtifacts(findArtifactCandidates(content), content, artifactPaths);
}

/**
 * Pull every plausible file-path candidate out of the message body.
 * Three passes in decreasing confidence order:
 *
 *   1. Markdown code spans — the model almost always wraps filenames
 *      in backticks.
 *   2. Markdown link targets — catches hand-authored `[label](path)`.
 *   3. (Bare-word matching happens in the resolver, not here, because
 *      it needs the artifact list to avoid munging every word in prose.)
 *
 * Duplicates are fine — the resolver dedupes on canonical paths.
 */
export function findArtifactCandidates(content: string): string[] {
  const out: string[] = [];
  // Pass 1: inline code spans. Skip triple-backtick fenced blocks by
  // consuming them first so their contents don't leak into candidates.
  const stripped = content.replace(/```[\s\S]*?```/g, ' ').replace(/~~~[\s\S]*?~~~/g, ' ');
  const codeRe = /`([^`\n]{1,200})`/g;
  for (const m of stripped.matchAll(codeRe)) {
    if (m[1]) out.push(m[1]);
  }
  // Pass 2: markdown link targets. `[label](target)`.
  const linkRe = /\[[^\]]*\]\(\s*([^\s)]+)[^)]*\)/g;
  for (const m of stripped.matchAll(linkRe)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/**
 * Normalize a candidate token and match it against the artifact list.
 * Returns the canonical path from the artifact list on hit, else null.
 */
function resolveCandidate(
  raw: string,
  byFullPath: Map<string, string>,
  byBasename: Map<string, string[]>,
): string | null {
  const cleaned = normalizeCandidate(raw);
  if (!cleaned) return null;
  // Absolute URLs are never artifact references.
  if (/^(https?:|mailto:|data:|file:|ftp:)/i.test(cleaned)) return null;
  // Exact path match (case-insensitive).
  const hitFull = byFullPath.get(cleaned.toLowerCase());
  if (hitFull) return hitFull;
  // Basename-only match. Unambiguous only — if two artifacts share the
  // same basename, we can't safely guess which one the model meant.
  const lastSlash = cleaned.lastIndexOf('/');
  const basename = lastSlash >= 0 ? cleaned.slice(lastSlash + 1) : cleaned;
  const candidates = byBasename.get(basename.toLowerCase());
  if (candidates && candidates.length === 1) return candidates[0]!;
  return null;
}

function normalizeCandidate(raw: string): string {
  let s = raw.trim();
  // Strip surrounding quotes / parens / brackets.
  s = s.replace(/^['"“”‘’`(<[]+/, '').replace(/['"“”‘’`)>\].,;:!?]+$/, '');
  // Leading ./ or /.
  s = s.replace(/^\.\//, '').replace(/^\/+/, '');
  return s.trim();
}

function matchCandidatesAgainstArtifacts(
  candidates: string[],
  content: string,
  artifactPaths: string[],
): string[] {
  // Index artifacts for fast lookup in both forms.
  const byFullPath = new Map<string, string>();
  const byBasename = new Map<string, string[]>();
  for (const p of artifactPaths) {
    byFullPath.set(p.toLowerCase(), p);
    const base = p.slice(p.lastIndexOf('/') + 1).toLowerCase();
    const existing = byBasename.get(base);
    if (existing) existing.push(p);
    else byBasename.set(base, [p]);
  }
  const hits = new Set<string>();
  // Pass 1+2: run candidates through the resolver.
  for (const cand of candidates) {
    const hit = resolveCandidate(cand, byFullPath, byBasename);
    if (hit) hits.add(hit);
  }
  // Pass 3: bare word-boundary mentions of any known artifact basename
  // or full path. Runs against the *full* content (fenced code blocks
  // included — we want to catch filenames the model dropped in prose
  // without backticks), but is guarded by the unambiguous-basename
  // constraint above so false positives stay low.
  const lowered = content.toLowerCase();
  for (const [basename, fullPaths] of byBasename) {
    if (fullPaths.length !== 1) continue; // only unambiguous basenames
    const canonical = fullPaths[0]!;
    if (hits.has(canonical)) continue;
    // Word-boundary scan: preceded by start/non-word and followed by
    // end/non-word. We treat `/` and `.` as word-ish for filename sanity.
    const escaped = escapeRegExp(basename);
    const re = new RegExp(`(^|[^\\w./])(${escaped})(?=[^\\w]|$)`, 'i');
    if (re.test(lowered)) hits.add(canonical);
  }
  // Return in a deterministic order (path-sorted) so downstream
  // persisted data and tests stay stable.
  return [...hits].sort();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
