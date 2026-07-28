import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { postSniffFeedback } from '../sniff-feedback.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import {
  materializeProjectWorkspace,
  provisionScenarioGezel,
  spawnAndAwait,
  workspaceContentRevision,
} from './helpers.ts';

/**
 * Symptom-debug — an undocumented bug; a failing acceptance script is
 * the only spec.
 *
 * self-correction seeds a *syntax* error; fix-squisq seeds a *bug
 * report*. Here there is neither: `lib/paginate.mjs` looks correct and
 * parses cleanly, but carries one subtle semantic bug — the encode side
 * of the cursor stores the index of the NEXT item to return while the
 * decode side resumes one PAST the cursor, so the item sitting on every
 * page boundary is silently skipped. The only specification is the
 * observable output of the read-only `accept.mjs` (8 cases printing
 * `CASE n: expected X got Y` on failure). The fix is a one-line change
 * once correctly diagnosed.
 *
 * The grader is behavioral: materialize the workspace, run
 * `node accept.mjs`, require exit 0 + the literal `ALL CASES PASS`
 * line. `accept.mjs` itself must stay byte-identical to the seed
 * (haversine-untouched pattern) — required signal `accept-untouched`.
 * Failing CASE lines are relayed to the model verbatim.
 */

const PROJECT_NAME = 'Pagination Service';
const DEVELOPER_NAME = 'Theo';

export const PAGINATE_PATH = 'lib/paginate.mjs';
export const ACCEPT_PATH = 'accept.mjs';

// ─────────────────────────────────────────────────────────────────────
// Fixture files (the seeded starting state).

export const PKG_JSON = `{
  "name": "pagination-service",
  "private": true,
  "type": "module",
  "scripts": { "accept": "node accept.mjs" }
}
`;

/**
 * The buggy module. The defect: cursors are ENCODED as "index of the
 * next unreturned item" (`encodeCursor(nextIndex)`), but DECODED as
 * "index of the last returned item" (`decodeCursor(cursor) + 1`) — so
 * resuming from a cursor skips exactly one item per page boundary.
 * The one-line fix is dropping the `+ 1`.
 */
export const PAGINATE_MJS = `// Cursor-based pagination over an in-memory list.
//
// A cursor is an opaque token marking the caller's position in the
// list. Callers pass the nextCursor from one page to fetch the next.

export function encodeCursor(index) {
  return Buffer.from(\`idx:\${index}\`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor) {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!raw.startsWith('idx:')) {
    throw new Error(\`malformed cursor: \${cursor}\`);
  }
  const index = Number(raw.slice(4));
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(\`malformed cursor: \${cursor}\`);
  }
  return index;
}

export function paginate(items, options = {}) {
  const limit = options.limit ?? 3;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(\`limit must be a positive integer, got \${limit}\`);
  }
  // Resume one past the cursor position.
  const start = options.cursor == null ? 0 : decodeCursor(options.cursor) + 1;
  const page = items.slice(start, start + limit);
  const nextIndex = start + page.length;
  const nextCursor = nextIndex < items.length ? encodeCursor(nextIndex) : null;
  return { items: page, nextCursor };
}
`;

/** The read-only acceptance gate. 8 cases; prints verbatim-relayable failures. */
export const ACCEPT_MJS = `// Acceptance script for the pagination module. DO NOT MODIFY THIS FILE.
// Run with: node accept.mjs
import { paginate } from './lib/paginate.mjs';

const ITEMS = [
  { id: 'a1', name: 'alpha' },
  { id: 'a2', name: 'bravo' },
  { id: 'a3', name: 'charlie' },
  { id: 'a4', name: 'delta' },
  { id: 'a5', name: 'echo' },
  { id: 'a6', name: 'foxtrot' },
  { id: 'a7', name: 'golf' },
  { id: 'a8', name: 'hotel' },
  { id: 'a9', name: 'india' },
  { id: 'a10', name: 'juliet' },
];

let failures = 0;
function check(n, expected, got) {
  const e = JSON.stringify(expected);
  const g = JSON.stringify(got);
  if (e !== g) {
    failures += 1;
    console.log(\`CASE \${n}: expected \${e} got \${g}\`);
  }
}

function walk(limit) {
  const seen = [];
  let cursor = null;
  for (let hops = 0; hops < 20; hops += 1) {
    const page = paginate(ITEMS, { cursor, limit });
    seen.push(...page.items.map((x) => x.id));
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return seen;
}

const p1 = paginate(ITEMS, { limit: 3 });
check(1, ['a1', 'a2', 'a3'], p1.items.map((x) => x.id));
check(2, true, p1.nextCursor !== null);

const p2 = paginate(ITEMS, { cursor: p1.nextCursor, limit: 3 });
check(3, 'a4', p2.items.length > 0 ? p2.items[0].id : null);

check(4, ITEMS.map((x) => x.id), walk(3));

const walked4 = walk(4);
check(5, walked4.length, new Set(walked4).size);
check(6, ITEMS.map((x) => x.id), walked4);

const big = paginate(ITEMS, { limit: 50 });
check(7, { count: 10, nextCursor: null }, { count: big.items.length, nextCursor: big.nextCursor });

check(8, { items: [], nextCursor: null }, paginate([], { limit: 3 }));

if (failures > 0) {
  console.log(\`\${failures} case(s) failed\`);
  process.exit(1);
}
console.log('ALL CASES PASS');
`;

// ─────────────────────────────────────────────────────────────────────
// User-shaped texts (exported so evidence tooling can lint required
// signals against the de-facto prompt).

export const MISSION_OBJECTIVES = [
  `1. Diagnose from observed behavior: run-and-read the failing CASE output of ${ACCEPT_PATH} and study ${PAGINATE_PATH} — there is no written bug report.`,
  `2. Fix the defect in ${PAGINATE_PATH} so every acceptance case passes.`,
  `3. Do not modify ${ACCEPT_PATH} in any way — it is the read-only acceptance gate and must stay byte-identical to how it was seeded.`,
  `4. Done means: node ${ACCEPT_PATH} prints ALL CASES PASS and exits 0.`,
].join(' ');

export const KICKOFF_MESSAGE = [
  `Running \`node ${ACCEPT_PATH}\` in this project currently FAILS — it prints lines like`,
  '`CASE n: expected X got Y` and exits non-zero. Your job: make it pass (it must print',
  `ALL CASES PASS and exit 0) WITHOUT modifying ${ACCEPT_PATH}. There is no bug report —`,
  `the acceptance script's observed output is the only spec. Read ${PAGINATE_PATH} and`,
  'reason about which cases fail and why; the underlying defect is small (a few lines at',
  `most) once correctly diagnosed. The checker fails the task if ${ACCEPT_PATH} changes`,
  'in any way, so leave it untouched. Edit files in place via write_file/replace_in_file —',
  'paths are relative to the workspace root, no leading "workspace/". Do NOT run npm',
  'install or any shell command — there is no node_modules; the harness runs',
  `\`node ${ACCEPT_PATH}\` automatically every few seconds and reports the failing CASE`,
  'lines back to you via chat verbatim.',
].join(' ');

// ─────────────────────────────────────────────────────────────────────

async function findProjectId(client: GezelClient): Promise<string | null> {
  const { projects } = await client.listProjects();
  return projects.find((p) => p.name === PROJECT_NAME)?.id ?? null;
}

async function readWorkspaceText(
  client: GezelClient,
  projectId: string,
  filePath: string,
): Promise<string | null> {
  try {
    const blob = await client.fetchProjectWorkspaceBlob(projectId, filePath);
    return await blob.text();
  } catch {
    return null;
  }
}

async function setup(ctx: EvalContext): Promise<void> {
  const { client, log } = ctx;
  let projectId = await findProjectId(client);
  if (!projectId) {
    const created = await client.createProject({
      name: PROJECT_NAME,
      about:
        'A small cursor-pagination module that looks correct but fails its read-only acceptance ' +
        'script. There is no bug report — the failing CASE output of accept.mjs is the only ' +
        'specification. Diagnose the defect in lib/paginate.mjs from observed behavior and fix it.',
      missionObjectives: MISSION_OBJECTIVES,
    });
    projectId = created.id;
    log(`[scenario:setup] created project name="${PROJECT_NAME}" id=${projectId}`);
  } else {
    log(`[scenario:setup] reusing existing project id=${projectId}`);
  }
  if (!projectId) throw new Error('symptom-debug setup: failed to resolve project id');

  const seedFiles: Array<{ path: string; content: string }> = [
    { path: 'package.json', content: PKG_JSON },
    { path: ACCEPT_PATH, content: ACCEPT_MJS },
    { path: PAGINATE_PATH, content: PAGINATE_MJS },
  ];
  for (const f of seedFiles) {
    await client.writeProjectWorkspaceFile(projectId, f);
  }
  log(`[scenario:setup] seeded ${seedFiles.length} fixture files under project ${projectId}`);

  const dev = await provisionScenarioGezel(ctx, {
    preferredName: DEVELOPER_NAME,
    role: 'Developer',
    label: 'developer',
  });
  await client.addGezelToProject(projectId, dev.id);
  log(`[scenario:setup] joined ${dev.name} to project ${projectId}`);

  await client.sendChatMessage(dev.id, {
    message: KICKOFF_MESSAGE,
    projectId,
  });
  log(`[scenario:setup] sent kickoff to ${dev.name} in project ${projectId}`);
}

// ─────────────────────────────────────────────────────────────────────
// Grader machinery — pure helpers exported so the grader tests run
// without a daemon (the unwinnable-grader guard).

/** accept.mjs must be byte-identical to the seed (modulo trailing whitespace). */
export function detectAcceptUntouched(acceptText: string | null): boolean {
  return acceptText !== null && acceptText.trim() === ACCEPT_MJS.trim();
}

export interface AcceptRunResult {
  ok: boolean;
  exitCode: number | null;
  /** Verbatim `CASE n: expected X got Y` lines from the acceptance run. */
  caseFailures: string[];
  /** First error line when the script crashed without printing cases. */
  crashLine?: string;
  timedOut: boolean;
}

const HIDDEN_PROBE_MARKER = 'GEZEL_PAGINATION_PROBE_PASS';
const HIDDEN_PAGINATION_PROBE = `import assert from 'node:assert/strict';
import { paginate } from './lib/paginate.mjs';

const items = Array.from({ length: 11 }, (_, index) => ({ id: 'hidden-' + index }));
const walked = [];
let cursor = null;
for (let hops = 0; hops < 20; hops += 1) {
  const page = paginate(items, { cursor, limit: 4 });
  walked.push(...page.items.map((item) => item.id));
  if (page.nextCursor === null) break;
  cursor = page.nextCursor;
}
assert.deepEqual(walked, items.map((item) => item.id));
assert.deepEqual(paginate([], { limit: 2 }), { items: [], nextCursor: null });
assert.throws(() => paginate(items, { limit: 0 }), /positive integer/);
console.log('${HIDDEN_PROBE_MARKER}');
`;

/**
 * Run `node accept.mjs` against a materialized workspace directory.
 * Returns null only on harness trouble (spawn failure with no exit code).
 */
export async function runAcceptInDir(dir: string): Promise<AcceptRunResult | null> {
  try {
    const result = await spawnAndAwait(process.execPath, [join(dir, ACCEPT_PATH)], {
      cwd: dir,
      timeoutMs: 30_000,
    });
    if (result.timedOut) {
      return {
        ok: false,
        exitCode: result.exitCode,
        caseFailures: [],
        crashLine: 'node accept.mjs timed out after 30s — check for an infinite loop',
        timedOut: true,
      };
    }
    if (result.exitCode === null) return null;
    const lines = [...result.stdout.split('\n'), ...result.stderr.split('\n')].map((l) => l.trim());
    const caseFailures = lines.filter((l) => /^CASE \d+:/.test(l));
    const acceptancePassed = result.exitCode === 0 && lines.some((l) => l === 'ALL CASES PASS');
    let hiddenProbePassed = false;
    let hiddenProbeFailure: string | undefined;
    if (acceptancePassed) {
      const probe = await spawnAndAwait(
        process.execPath,
        ['--input-type=module', '--eval', HIDDEN_PAGINATION_PROBE],
        { cwd: dir, timeoutMs: 30_000 },
      );
      const probeOutput = `${probe.stdout}\n${probe.stderr}`;
      hiddenProbePassed =
        probe.exitCode === 0 && probeOutput.split(/\r?\n/).includes(HIDDEN_PROBE_MARKER);
      if (!hiddenProbePassed) {
        hiddenProbeFailure = probe.timedOut
          ? 'hidden pagination probe timed out after 30s'
          : `hidden pagination probe did not complete: ${probe.stderr.split(/\r?\n/).find(Boolean)?.slice(0, 200) ?? 'missing pass marker'}`;
      }
    }
    const allPass = acceptancePassed && hiddenProbePassed;
    let crashLine: string | undefined;
    if (!allPass && caseFailures.length === 0) {
      crashLine =
        hiddenProbeFailure ??
        result.stderr
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l.length > 0)
          ?.slice(0, 200);
    }
    return { ok: allPass, exitCode: result.exitCode, caseFailures, crashLine, timedOut: false };
  } catch {
    return null;
  }
}

export const SYMPTOM_DEBUG_SIGNALS = ['accept-untouched', 'paginate-changed', 'accept-passes'];
const REQUIRED_SIGNALS = ['accept-untouched', 'accept-passes'];

export interface SymptomDebugVerdict {
  ok: boolean;
  signals: string[];
  missingRequiredSignals: string[];
  failReason?: string;
  accept: AcceptRunResult | null;
}

/**
 * Pure verdict composition shared by the live successCheck and the
 * directory-based verifier, so the two can't drift.
 */
export function composeSymptomDebugVerdict(parts: {
  acceptText: string | null;
  paginateText: string | null;
  accept: AcceptRunResult | null;
}): SymptomDebugVerdict {
  const { acceptText, paginateText, accept } = parts;
  const signals: string[] = [];
  const failures: string[] = [];

  const acceptUntouched = detectAcceptUntouched(acceptText);
  if (acceptUntouched) signals.push('accept-untouched');
  else if (acceptText === null)
    failures.push(
      `${ACCEPT_PATH} is missing from the workspace — restore the seeded file exactly; it is the read-only acceptance gate`,
    );
  else
    failures.push(
      `${ACCEPT_PATH} was modified — restore it to exactly the seeded version; it is the read-only acceptance gate and must not change`,
    );

  if (paginateText !== null && paginateText.trim() !== PAGINATE_MJS.trim()) {
    signals.push('paginate-changed');
  }
  if (paginateText === null) {
    failures.push(`${PAGINATE_PATH} is missing from the workspace — it must exist`);
  }

  if (accept?.ok) {
    signals.push('accept-passes');
  } else if (accept && !accept.ok) {
    failures.push(
      accept.caseFailures.length > 0
        ? `node ${ACCEPT_PATH} still failing: ${accept.caseFailures.slice(0, 8).join(' | ')}`.slice(
            0,
            900,
          )
        : `node ${ACCEPT_PATH} crashed (exit ${accept.exitCode ?? 'none'}): ${accept.crashLine ?? 'no output'}`,
    );
  }

  const ok = signals.includes('accept-untouched') && signals.includes('accept-passes');
  return {
    ok,
    signals,
    missingRequiredSignals: REQUIRED_SIGNALS.filter((s) => !signals.includes(s)),
    failReason: failures.length > 0 ? failures[0] : undefined,
    accept,
  };
}

/**
 * Offline verification of a symptom-debug workspace DIRECTORY (no
 * daemon): accept-untouched guard + a real `node accept.mjs` run. Used
 * by the grader tests and by failure-class backfills.
 */
export async function verifySymptomDebugWorkspaceDir(dir: string): Promise<SymptomDebugVerdict> {
  const acceptText = await readFile(join(dir, ACCEPT_PATH), 'utf8').catch(() => null);
  const paginateText = await readFile(join(dir, PAGINATE_PATH), 'utf8').catch(() => null);
  // Never run a model-modified acceptance script — that gate is gameable;
  // the untouched guard already failed and the verdict says to restore it.
  const accept = detectAcceptUntouched(acceptText) ? await runAcceptInDir(dir) : null;
  return composeSymptomDebugVerdict({ acceptText, paginateText, accept });
}

// ─────────────────────────────────────────────────────────────────────

const acceptGateCache = new WeakMap<
  EvalContext,
  { lastHash: string; lastResult: AcceptRunResult | null }
>();

async function runAcceptGate(
  ctx: EvalContext,
  client: GezelClient,
  projectId: string,
  contentHash: string,
  log: (line: string) => void,
): Promise<AcceptRunResult | null> {
  const cached = acceptGateCache.get(ctx);
  if (cached && cached.lastHash === contentHash) return cached.lastResult;
  const tmp = await mkdtemp(`${tmpdir()}/gezel-eval-symptom-debug-`);
  try {
    await materializeProjectWorkspace(client, projectId, tmp, {
      include: /\.(mjs|cjs|js|json)$/,
    });
    const result = await runAcceptInDir(tmp);
    if (result === null) {
      log('[scenario] accept gate unavailable (harness error) — will retry next poll');
    } else {
      log(
        `[scenario] accept gate: ok=${result.ok} exit=${result.exitCode}${
          result.caseFailures.length > 0 ? ` first="${result.caseFailures[0]?.slice(0, 120)}"` : ''
        }${result.crashLine ? ` crash="${result.crashLine.slice(0, 120)}"` : ''}`,
      );
      acceptGateCache.set(ctx, { lastHash: contentHash, lastResult: result });
    }
    return result;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

export const symptomDebugScenario: EvalScenario = {
  id: 'symptom-debug',
  description:
    'An undocumented semantic bug (cursor-pagination boundary off-by-one) with a read-only failing acceptance script as the only spec. Diagnose from observed CASE output and fix lib/paginate.mjs so `node accept.mjs` prints ALL CASES PASS — without touching accept.mjs.',
  prompt: [
    `Heads up: ${DEVELOPER_NAME} is debugging why accept.mjs fails in the "${PROJECT_NAME}"`,
    "project. You don't need to do anything — just confirm you've seen this note.",
  ].join(' '),
  evidenceTexts: [KICKOFF_MESSAGE, MISSION_OBJECTIVES],
  timeoutMs: 20 * 60_000,
  progressTimeoutMs: 10 * 60_000,
  setup,
  skipInitialPrompt: true,
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const { client, log, logChanged, recordSniff } = ctx;
    const projectId = await findProjectId(client);
    if (!projectId) {
      logChanged('project', '[scenario] pagination-service project not present yet');
      return { done: false };
    }

    const [acceptText, paginateText] = await Promise.all([
      readWorkspaceText(client, projectId, ACCEPT_PATH),
      readWorkspaceText(client, projectId, PAGINATE_PATH),
    ]);

    // Run the acceptance gate only when content changed since the last
    // poll (content-hash cache) and never with a modified accept.mjs.
    let accept: AcceptRunResult | null = null;
    if (detectAcceptUntouched(acceptText) && paginateText !== null) {
      try {
        const revision = await workspaceContentRevision(
          client,
          projectId,
          /\.(?:mjs|cjs|js|json)$/,
        );
        accept = await runAcceptGate(ctx, client, projectId, revision, log);
      } catch (error) {
        logChanged(
          'gate-revision',
          `[scenario] unable to fingerprint pagination workspace yet: ${String(error).slice(0, 180)}`,
        );
      }
    }

    const verdict = composeSymptomDebugVerdict({ acceptText, paginateText, accept });
    const bytes = paginateText?.length ?? 0;
    logChanged(
      'sniff',
      `[scenario] symptom-debug bytes=${bytes} score=${verdict.signals.length}/${SYMPTOM_DEBUG_SIGNALS.length} signals=${verdict.signals.join(',') || 'none'}${verdict.failReason ? ` failReason="${verdict.failReason}"` : ''}`,
    );
    recordSniff?.({ key: 'symptom-debug', score: verdict.signals.length, bytes });

    if (verdict.ok) {
      return {
        done: true,
        success: true,
        reason: `node accept.mjs prints ALL CASES PASS with accept.mjs untouched (signals: ${verdict.signals.join(', ')})`,
      };
    }

    if (verdict.failReason) {
      const target = verdict.signals.includes('accept-untouched') ? PAGINATE_PATH : ACCEPT_PATH;
      await postSniffFeedback(ctx, target, {
        ok: false,
        signals: verdict.signals,
        score: verdict.signals.length,
        failReason: verdict.failReason,
        missingRequiredSignals: verdict.missingRequiredSignals,
      });
    }
    return { done: false };
  },
};
