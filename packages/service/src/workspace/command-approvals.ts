import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CommandApprovalScope } from '@bendyline/gezel';
import { projectLocalDir } from '@bendyline/gezel/paths';
import { writeFileAtomic } from '../fs/atomic.js';

/**
 * Per-project first-use approvals for `run_package_script` / `run_npx`.
 * Sibling to `npm-allowlist.json` in layout and intent — a small JSON
 * file the user owns, lookups on each tool call, writes on each answered
 * approval question.
 *
 * Shape:
 *   { scripts: { build: 'approved' | 'declined', ... },
 *     npx:     { vitest: 'approved', ... },
 *     scriptHashes: { build: '<sha256 of the approved body>' },
 *     npxHashes:    { ... } }
 *
 * An `approved` decision is honored ONLY while the command's body hash
 * still matches the hash captured at approval time. Args are NOT part of
 * the key (consistent with how `npm_install` approves a package, not a
 * version-arg combo), but the BODY is — otherwise a prompt-injected model
 * could rewrite an approved `build` script to run arbitrary code and
 * replay the old approval with no fresh prompt. A changed body (or a
 * legacy approval stored before hashing existed) forces a re-prompt.
 */

export type CommandApprovalDecision = 'approved' | 'declined';

export interface CommandApprovalsFile {
  scripts: Record<string, CommandApprovalDecision>;
  npx: Record<string, CommandApprovalDecision>;
  scriptHashes?: Record<string, string>;
  npxHashes?: Record<string, string>;
}

/** sha256 of the resolved command body; the approval key's content anchor. */
export function hashCommandBody(body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  return createHash('sha256').update(body).digest('hex');
}

function approvalsPath(home: string, projectId: string): string {
  return join(projectLocalDir(home, projectId), 'command-approvals.json');
}

export async function readCommandApprovals(
  home: string,
  projectId: string,
): Promise<CommandApprovalsFile> {
  const file = approvalsPath(home, projectId);
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CommandApprovalsFile>;
    return {
      scripts: normalizeBucket(parsed.scripts),
      npx: normalizeBucket(parsed.npx),
      scriptHashes: normalizeHashes(parsed.scriptHashes),
      npxHashes: normalizeHashes(parsed.npxHashes),
    };
  } catch {
    return { scripts: {}, npx: {} };
  }
}

export async function writeCommandApprovals(
  home: string,
  projectId: string,
  data: CommandApprovalsFile,
): Promise<void> {
  const file = approvalsPath(home, projectId);
  if (!existsSync(dirname(file))) await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function lookupApproval(
  file: CommandApprovalsFile,
  scope: CommandApprovalScope,
  name: string,
  contentHash?: string,
): CommandApprovalDecision | undefined {
  const bucket = scope === 'script' ? file.scripts : file.npx;
  const decision = bucket[name];
  // A decline (or no decision) passes through unchanged.
  if (decision !== 'approved') return decision;
  // An approval is honored only while the body still hashes to what the
  // user approved. No caller-supplied hash → legacy name-only match. A
  // missing (pre-hashing) or mismatched stored hash forces a re-prompt.
  if (contentHash === undefined) return 'approved';
  const hashes = scope === 'script' ? file.scriptHashes : file.npxHashes;
  return hashes?.[name] === contentHash ? 'approved' : undefined;
}

export async function recordApproval(
  home: string,
  projectId: string,
  scope: CommandApprovalScope,
  name: string,
  decision: CommandApprovalDecision,
  contentHash?: string,
): Promise<void> {
  const existing = await readCommandApprovals(home, projectId);
  const scriptHashes = { ...existing.scriptHashes };
  const npxHashes = { ...existing.npxHashes };
  const next: CommandApprovalsFile = {
    scripts: { ...existing.scripts },
    npx: { ...existing.npx },
    scriptHashes,
    npxHashes,
  };
  const bucket = scope === 'script' ? next.scripts : next.npx;
  const hashes = scope === 'script' ? scriptHashes : npxHashes;
  bucket[name] = decision;
  // Only an approval pins a body hash; a decline clears any stale one.
  if (decision === 'approved' && contentHash) hashes[name] = contentHash;
  else delete hashes[name];
  await writeCommandApprovals(home, projectId, next);
}

function normalizeBucket(
  raw: Record<string, CommandApprovalDecision> | undefined,
): Record<string, CommandApprovalDecision> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, CommandApprovalDecision> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === 'approved' || v === 'declined') out[k] = v;
  }
  return out;
}

function normalizeHashes(raw: Record<string, string> | undefined): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return out;
}
