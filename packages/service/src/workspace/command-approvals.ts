import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type CommandApprovalInputFile,
  type CommandApprovalScope,
  KeyedLock,
} from '@bendyline/gezel';
import { projectPrivateDir } from '@bendyline/gezel/paths';
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
 *     scriptHashes: { build: '<sha256 of the approved invocation + input files>' },
 *     npxHashes:    { ... },
 *     scriptInvocationHashes: { build: ['<approved invocation>', ...] },
 *     npxInvocationHashes: { ... } }
 *
 * An `approved` decision is honored ONLY while the command body/path,
 * ordered argument vector, and identifiable input-file contents match what
 * the user saw. Otherwise a
 * prompt-injected model could approve a benign invocation and replay the
 * stored decision with shell metacharacters or materially different tool
 * arguments. A changed body, changed arguments, or a legacy body-only
 * approval forces a re-prompt.
 */

export type CommandApprovalDecision = 'approved' | 'declined';

export interface CommandApprovalsFile {
  scripts: Record<string, CommandApprovalDecision>;
  npx: Record<string, CommandApprovalDecision>;
  scriptHashes?: Record<string, string>;
  npxHashes?: Record<string, string>;
  /** Retain independently approved invocations when fanout tasks share a command. */
  scriptInvocationHashes?: Record<string, string[]>;
  npxInvocationHashes?: Record<string, string[]>;
}

const approvalLocks = new KeyedLock();
const MAX_INVOCATIONS_PER_COMMAND = 64;

/** sha256 of the exact body/path + ordered args + input snapshot the user approved. */
export function hashCommandInvocation(
  body: string | undefined,
  args: readonly string[],
  inputFiles: readonly CommandApprovalInputFile[] = [],
): string {
  // The versioned JSON envelope is unambiguous and deliberately differs
  // from legacy sha256(body) and v1 body+args values, so upgrades fail
  // closed and prompt once under the new content-bound contract.
  const files = [...inputFiles]
    .map(({ path, sha256 }) => ({ path, sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.sha256.localeCompare(b.sha256));
  const payload = JSON.stringify({ version: 2, body: body ?? null, args, files });
  return createHash('sha256').update('gezel-command-invocation\0').update(payload).digest('hex');
}

function approvalsPath(home: string, projectId: string): string {
  return join(projectPrivateDir(home, projectId), 'command-approvals.json');
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
      scriptInvocationHashes: normalizeInvocationHashes(parsed.scriptInvocationHashes),
      npxInvocationHashes: normalizeInvocationHashes(parsed.npxInvocationHashes),
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
  invocationHash?: string,
): CommandApprovalDecision | undefined {
  const bucket = scope === 'script' ? file.scripts : file.npx;
  const decision = bucket[name];
  // A decline (or no decision) passes through unchanged.
  if (decision !== 'approved') return decision;
  // An approval without an exact invocation hash is never executable.
  // Missing legacy hashes and body-only hashes both force a re-prompt.
  if (invocationHash === undefined) return undefined;
  const hashes = scope === 'script' ? file.scriptHashes : file.npxHashes;
  const invocations = scope === 'script' ? file.scriptInvocationHashes : file.npxInvocationHashes;
  return hashes?.[name] === invocationHash || invocations?.[name]?.includes(invocationHash)
    ? 'approved'
    : undefined;
}

export async function recordApproval(
  home: string,
  projectId: string,
  scope: CommandApprovalScope,
  name: string,
  decision: CommandApprovalDecision,
  invocationHash?: string,
): Promise<void> {
  await approvalLocks.run(approvalsPath(home, projectId), async () => {
    const existing = await readCommandApprovals(home, projectId);
    const scriptHashes = { ...existing.scriptHashes };
    const npxHashes = { ...existing.npxHashes };
    const scriptInvocationHashes = { ...existing.scriptInvocationHashes };
    const npxInvocationHashes = { ...existing.npxInvocationHashes };
    const next: CommandApprovalsFile = {
      scripts: { ...existing.scripts },
      npx: { ...existing.npx },
      scriptHashes,
      npxHashes,
      scriptInvocationHashes,
      npxInvocationHashes,
    };
    const bucket = scope === 'script' ? next.scripts : next.npx;
    const hashes = scope === 'script' ? scriptHashes : npxHashes;
    const invocations = scope === 'script' ? scriptInvocationHashes : npxInvocationHashes;
    const priorDecision = bucket[name];
    bucket[name] = decision;
    // Older readers still see only the latest exact hash. New readers retain a
    // bounded set, never a command-wide wildcard. Declines revoke the entire set.
    if (decision === 'approved' && invocationHash) {
      const prior =
        priorDecision === 'approved'
          ? [...(invocations[name] ?? []), ...(hashes[name] ? [hashes[name]!] : [])]
          : [];
      invocations[name] = [
        ...new Set(prior.filter((hash) => hash !== invocationHash)),
        invocationHash,
      ].slice(-MAX_INVOCATIONS_PER_COMMAND);
      hashes[name] = invocationHash;
    } else {
      delete hashes[name];
      delete invocations[name];
    }
    await writeCommandApprovals(home, projectId, next);
  });
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

function normalizeInvocationHashes(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [name, values] of Object.entries(raw)) {
    if (Array.isArray(values)) {
      out[name] = [
        ...new Set(
          values.filter(
            (value): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
          ),
        ),
      ].slice(-MAX_INVOCATIONS_PER_COMMAND);
    }
  }
  return out;
}
