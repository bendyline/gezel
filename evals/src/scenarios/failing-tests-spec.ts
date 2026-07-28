import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { postSniffFeedback } from '../sniff-feedback.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import {
  materializeProjectWorkspace,
  provisionScenarioGezel,
  spawnAndAwait,
  workspaceContentRevision,
} from './helpers.ts';
import {
  TRUSTED_CHECK_RUNNER_ENV,
  TRUSTED_RUNNER_KICKOFF,
  trustedCheckRunnerEnabled,
} from './trusted-check-runner.ts';

export { TRUSTED_CHECK_RUNNER_ENV, trustedCheckRunnerEnabled } from './trusted-check-runner.ts';

/**
 * Failing-tests-spec — the test suite is the only specification.
 *
 * schema-migration has the model WRITE tests; here the tests are given,
 * read-only, and prose is deliberately absent: ~15 vitest cases pin the
 * full behavior of a small order-lifecycle state machine via assertions
 * alone (states, events, a guard, a history log, exact error messages),
 * and `src/machine.ts` is an empty skeleton. The model must infer the
 * spec from the assertions and implement until the suite is green.
 *
 * Grading runs both quality layers end-to-end: the harness materializes
 * the workspace into a tempdir, runs the REAL vitest binary, and compiles
 * shipping source under the seeded strict TypeScript options. The structural
 * gate is `tests-untouched` — the seeded test file must stay byte-identical
 * (haversine-untouched pattern), otherwise a model could "pass" by rewriting
 * the spec. Failing test names, assertion lines, and the first compiler
 * diagnostic are relayed back to the model verbatim.
 */

const PROJECT_NAME = 'Machine Kata';
const DEVELOPER_NAME = 'Priya';
const INITIAL_SKELETON_FEEDBACK_GRACE_POLLS = 24;
const VITEST_FAILURE_REASON_MAX_CHARS = 900;
const TSC_DIAGNOSTIC_MAX_CHARS = 500;
const initialSkeletonPolls = new WeakMap<EvalContext, number>();

export const TEST_PATH = 'tests/machine.test.ts';
export const MACHINE_PATH = 'src/machine.ts';
export const TRUSTED_CHECK_PATH = '.gezel-checks/failing-tests-spec.mjs';

/**
 * Dependency-free behavioral checker used by the treatment arm. It imports
 * the candidate TypeScript through Node's strip-types runtime, runs inside
 * Gezel's existing workspace sandbox, and exits nonzero with named failures.
 * The gate pins these exact bytes, so candidate code cannot weaken its own
 * checker. The unchanged Vitest + strict-tsc harness remains the final grader.
 */
export const TRUSTED_CHECK_SOURCE = `import { createOrderMachine } from '../src/machine.ts';

const tests = [];
const add = (name, fn) => tests.push([name, fn]);
const equal = (actual, expected, label = 'value') => {
  if (!Object.is(actual, expected)) {
    throw new Error(label + ': expected ' + JSON.stringify(expected) + ', received ' + JSON.stringify(actual));
  }
};
const deepEqual = (actual, expected, label = 'value') => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(label + ': expected ' + e + ', received ' + a);
};
const throwsExact = (fn, expected) => {
  let caught;
  try { fn(); } catch (error) { caught = error; }
  if (!caught) throw new Error('expected an exception, but none was thrown');
  equal(caught instanceof Error ? caught.message : String(caught), expected, 'error message');
};

add('starts in draft with empty history', () => {
  const m = createOrderMachine();
  equal(m.state, 'draft', 'initial state');
  deepEqual(m.history, [], 'initial history');
});
add('submit moves draft to pending', () => {
  const m = createOrderMachine();
  equal(m.send('submit'), 'pending');
  equal(m.state, 'pending');
});
add('pay, ship, and deliver follow the happy path', () => {
  const m = createOrderMachine();
  m.send('submit');
  equal(m.send('pay'), 'paid');
  equal(m.send('ship'), 'shipped');
  equal(m.send('deliver'), 'delivered');
});
add('cancel works from draft, pending, and paid', () => {
  const a = createOrderMachine();
  equal(a.send('cancel'), 'cancelled');
  const b = createOrderMachine();
  b.send('submit');
  equal(b.send('cancel'), 'cancelled');
  const c = createOrderMachine();
  c.send('submit');
  c.send('pay');
  equal(c.send('cancel'), 'cancelled');
});
add('invalid and unknown events use the exact error shape', () => {
  const m = createOrderMachine();
  throwsExact(() => m.send('ship'), 'invalid transition: event "ship" is not allowed in state "draft"');
  throwsExact(() => m.send('refund'), 'invalid transition: event "refund" is not allowed in state "draft"');
});
add('cancel is rejected after shipping', () => {
  const m = createOrderMachine();
  m.send('submit'); m.send('pay'); m.send('ship');
  throwsExact(() => m.send('cancel'), 'invalid transition: event "cancel" is not allowed in state "shipped"');
});
add('delivered and cancelled are terminal', () => {
  const delivered = createOrderMachine();
  delivered.send('submit'); delivered.send('pay'); delivered.send('ship'); delivered.send('deliver');
  throwsExact(() => delivered.send('submit'), 'invalid transition: event "submit" is not allowed in state "delivered"');
  const cancelled = createOrderMachine();
  cancelled.send('cancel');
  throwsExact(() => cancelled.send('submit'), 'invalid transition: event "submit" is not allowed in state "cancelled"');
});
add('rejected sends do not mutate state or history', () => {
  const m = createOrderMachine();
  m.send('submit');
  try { m.send('deliver'); } catch {}
  equal(m.state, 'pending');
  equal(m.history.length, 1, 'history length');
});
add('can reports allowed events without mutation', () => {
  const m = createOrderMachine();
  equal(m.can('submit'), true);
  equal(m.can('cancel'), true);
  equal(m.can('ship'), false);
  equal(m.can('refund'), false);
  equal(m.state, 'draft');
});
add('can reflects the expedite guard', () => {
  const plain = createOrderMachine();
  plain.send('submit'); plain.send('pay');
  equal(plain.can('expedite'), false);
  const fast = createOrderMachine({ expedited: true });
  fast.send('submit'); fast.send('pay');
  equal(fast.can('expedite'), true);
});
add('history records successful transitions in order', () => {
  const m = createOrderMachine();
  m.send('submit'); m.send('pay'); m.send('ship');
  deepEqual(m.history, [
    { from: 'draft', to: 'pending', event: 'submit' },
    { from: 'pending', to: 'paid', event: 'pay' },
    { from: 'paid', to: 'shipped', event: 'ship' },
  ], 'history');
});
add('expedite ships only opted-in paid orders', () => {
  const fast = createOrderMachine({ expedited: true });
  fast.send('submit'); fast.send('pay');
  equal(fast.send('expedite'), 'shipped');
  const plain = createOrderMachine();
  plain.send('submit'); plain.send('pay');
  throwsExact(() => plain.send('expedite'), 'invalid transition: event "expedite" is not allowed in state "paid"');
});

const failures = [];
for (const [name, fn] of tests) {
  try { fn(); } catch (error) {
    failures.push(name + ': ' + (error instanceof Error ? error.message : String(error)));
  }
}
if (failures.length > 0) {
  console.error('FAIL ' + failures.length + '/' + tests.length + ' trusted checks');
  for (const failure of failures) console.error('- ' + failure);
  process.exitCode = 1;
} else {
  console.log('PASS ' + tests.length + '/' + tests.length + ' trusted checks');
}
`;

const requireFromHere = createRequire(import.meta.url);
const CONTROLLED_VITEST_CONFIG = join(
  dirname(fileURLToPath(import.meta.url)),
  'failing-tests-spec.vitest.config.mjs',
);
function resolveVitestBin(): string {
  const vitestPkg = requireFromHere.resolve('vitest/package.json');
  return join(dirname(vitestPkg), 'vitest.mjs');
}

function resolveTscBin(): string {
  const typescriptPkg = requireFromHere.resolve('typescript/package.json');
  return join(dirname(typescriptPkg), 'bin', 'tsc');
}

// ─────────────────────────────────────────────────────────────────────
// Fixture files (the seeded starting state).

export const PKG_JSON = `{
  "name": "machine-kata",
  "private": true,
  "type": "module",
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "devDependencies": { "typescript": "^5.7.3", "vitest": "^2.1.8" }
}
`;

export const TSCONFIG_JSON = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
`;

// Harness-owned typecheck config. The frozen Vitest file is exercised by the
// real test runner; this gate compiles the shipping source under the seeded
// strict options without trusting a model-authored tsconfig relaxation.
const TSC_GATE_CONFIG_JSON = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["tests/**/*", "node_modules"]
}
`;

/**
 * The read-only spec: assertions only, zero prose. Every requirement —
 * the state set, the transition table, the expedite guard, the history
 * log shape, and the exact invalid-transition error message — must be
 * inferred from these cases.
 */
export const MACHINE_TEST_TS = `import { describe, expect, it } from 'vitest';
import { createOrderMachine } from '../src/machine.ts';

describe('order machine: initial state', () => {
  it('starts in "draft"', () => {
    const m = createOrderMachine();
    expect(m.state).toBe('draft');
  });

  it('starts with an empty history log', () => {
    const m = createOrderMachine();
    expect(m.history).toEqual([]);
  });
});

describe('order machine: transitions', () => {
  it('submit moves draft to pending and returns the new state', () => {
    const m = createOrderMachine();
    expect(m.send('submit')).toBe('pending');
    expect(m.state).toBe('pending');
  });

  it('pay moves pending to paid', () => {
    const m = createOrderMachine();
    m.send('submit');
    expect(m.send('pay')).toBe('paid');
  });

  it('ship moves paid to shipped, deliver moves shipped to delivered', () => {
    const m = createOrderMachine();
    m.send('submit');
    m.send('pay');
    expect(m.send('ship')).toBe('shipped');
    expect(m.send('deliver')).toBe('delivered');
  });

  it('cancel is allowed from draft, pending, and paid', () => {
    const a = createOrderMachine();
    expect(a.send('cancel')).toBe('cancelled');
    const b = createOrderMachine();
    b.send('submit');
    expect(b.send('cancel')).toBe('cancelled');
    const c = createOrderMachine();
    c.send('submit');
    c.send('pay');
    expect(c.send('cancel')).toBe('cancelled');
  });
});

describe('order machine: invalid transitions', () => {
  it('rejects an event that is not allowed in the current state', () => {
    const m = createOrderMachine();
    expect(() => m.send('ship')).toThrowError(
      'invalid transition: event "ship" is not allowed in state "draft"',
    );
  });

  it('rejects an unknown event with the same error shape', () => {
    const m = createOrderMachine();
    expect(() => m.send('refund')).toThrowError(
      'invalid transition: event "refund" is not allowed in state "draft"',
    );
  });

  it('rejects cancel after shipping', () => {
    const m = createOrderMachine();
    m.send('submit');
    m.send('pay');
    m.send('ship');
    expect(() => m.send('cancel')).toThrowError(
      'invalid transition: event "cancel" is not allowed in state "shipped"',
    );
  });

  it('delivered and cancelled are terminal', () => {
    const m = createOrderMachine();
    m.send('submit');
    m.send('pay');
    m.send('ship');
    m.send('deliver');
    expect(() => m.send('submit')).toThrowError(
      'invalid transition: event "submit" is not allowed in state "delivered"',
    );
    const c = createOrderMachine();
    c.send('cancel');
    expect(() => c.send('submit')).toThrowError(
      'invalid transition: event "submit" is not allowed in state "cancelled"',
    );
  });

  it('a rejected send leaves the state unchanged', () => {
    const m = createOrderMachine();
    m.send('submit');
    expect(() => m.send('deliver')).toThrowError();
    expect(m.state).toBe('pending');
  });
});

describe('order machine: can()', () => {
  it('reports allowed events without changing state and never throws', () => {
    const m = createOrderMachine();
    expect(m.can('submit')).toBe(true);
    expect(m.can('cancel')).toBe(true);
    expect(m.can('ship')).toBe(false);
    expect(m.can('refund')).toBe(false);
    expect(m.state).toBe('draft');
  });

  it('reflects the expedite guard', () => {
    const plain = createOrderMachine();
    plain.send('submit');
    plain.send('pay');
    expect(plain.can('expedite')).toBe(false);
    const fast = createOrderMachine({ expedited: true });
    fast.send('submit');
    fast.send('pay');
    expect(fast.can('expedite')).toBe(true);
  });
});

describe('order machine: history log', () => {
  it('records every successful transition in order', () => {
    const m = createOrderMachine();
    m.send('submit');
    m.send('pay');
    m.send('ship');
    expect(m.history).toEqual([
      { from: 'draft', to: 'pending', event: 'submit' },
      { from: 'pending', to: 'paid', event: 'pay' },
      { from: 'paid', to: 'shipped', event: 'ship' },
    ]);
  });

  it('does not record rejected transitions', () => {
    const m = createOrderMachine();
    m.send('submit');
    expect(() => m.send('deliver')).toThrowError();
    expect(m.history).toHaveLength(1);
  });
});

describe('order machine: expedite guard', () => {
  it('expedite moves paid to shipped when created with { expedited: true }', () => {
    const fast = createOrderMachine({ expedited: true });
    fast.send('submit');
    fast.send('pay');
    expect(fast.send('expedite')).toBe('shipped');
  });

  it('expedite is rejected on a machine created without the flag', () => {
    const plain = createOrderMachine();
    plain.send('submit');
    plain.send('pay');
    expect(() => plain.send('expedite')).toThrowError(
      'invalid transition: event "expedite" is not allowed in state "paid"',
    );
  });
});
`;

const EXPECTED_TEST_COUNT = MACHINE_TEST_TS.match(/\bit\(/g)?.length ?? 0;

/** The seeded implementation: signature only, no behavior. */
export const MACHINE_SKELETON_TS = `export interface TransitionRecord {
  from: string;
  to: string;
  event: string;
}

export interface OrderMachine {
  readonly state: string;
  readonly history: TransitionRecord[];
  can(event: string): boolean;
  send(event: string): string;
}

export function createOrderMachine(_options?: { expedited?: boolean }): OrderMachine {
  throw new Error('createOrderMachine is not implemented yet');
}
`;

// ─────────────────────────────────────────────────────────────────────
// User-shaped texts. Exported so grader-lint / evidence tooling can
// check required-signal satisfiability against the de-facto prompt
// (the scenario `prompt` is just a benign meester note).

export const MISSION_OBJECTIVES = [
  `1. Read ${TEST_PATH} in full before writing any code — the assertions are the only specification; there is no README or prose spec.`,
  `2. Implement ${MACHINE_PATH} (createOrderMachine) so that every vitest case passes and the strict TypeScript check is clean.`,
  `3. Do not modify, delete, or add anything under tests/ — ${TEST_PATH} must stay byte-identical to how it was seeded.`,
  '4. Match observable behavior exactly, including the error messages the tests assert.',
].join(' ');

export const KICKOFF_MESSAGE = [
  `The test suite is the specification. Read ${TEST_PATH} — it pins the complete behavior of a`,
  `small order-lifecycle state machine via assertions only — then implement ${MACHINE_PATH} so`,
  'that every test passes. Do not modify anything under tests/: the tests are the read-only',
  `spec, and the checker fails the task if ${TEST_PATH} changes in any way. Every requirement`,
  '(states, events, the guard, the history log, exact error messages) must be inferred from the',
  `assertions. Edit ${MACHINE_PATH} in place via write_file/replace_in_file — paths are relative`,
  'to the workspace root, no leading "workspace/". Do NOT run npm install or any shell',
  'command — there is no node_modules; the harness runs `vitest run` against the project',
  'plus a strict `tsc --noEmit` check automatically every few seconds and reports failing test',
  'names, assertion messages, and compiler errors back to you via chat.',
].join(' ');

// ─────────────────────────────────────────────────────────────────────

async function findProjectId(client: GezelClient): Promise<string | null> {
  const { projects } = await client.listProjects();
  return projects.find((p) => p.name === PROJECT_NAME)?.id ?? null;
}

async function findDeveloperGezelId(client: GezelClient): Promise<string | undefined> {
  try {
    const { gezels } = await client.listGezels();
    return gezels.find((g) => g.name === DEVELOPER_NAME)?.id;
  } catch {
    return undefined;
  }
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
  const trustedRunner = trustedCheckRunnerEnabled();
  let projectId = await findProjectId(client);
  if (!projectId) {
    const created = await client.createProject({
      name: PROJECT_NAME,
      about:
        'A test-driven kata: the vitest suite under tests/ is the complete and only specification ' +
        'for a small order-lifecycle state machine. src/machine.ts is an empty skeleton that must ' +
        'be implemented until every test passes — without touching anything under tests/.',
      missionObjectives: MISSION_OBJECTIVES,
    });
    projectId = created.id;
    log(`[scenario:setup] created project name="${PROJECT_NAME}" id=${projectId}`);
  } else {
    log(`[scenario:setup] reusing existing project id=${projectId}`);
  }
  if (!projectId) throw new Error('failing-tests-spec setup: failed to resolve project id');

  const seedFiles: Array<{ path: string; content: string }> = [
    { path: 'package.json', content: PKG_JSON },
    { path: 'tsconfig.json', content: TSCONFIG_JSON },
    { path: TEST_PATH, content: MACHINE_TEST_TS },
    { path: MACHINE_PATH, content: MACHINE_SKELETON_TS },
    ...(trustedRunner ? [{ path: TRUSTED_CHECK_PATH, content: TRUSTED_CHECK_SOURCE }] : []),
  ];
  for (const f of seedFiles) {
    await client.writeProjectWorkspaceFile(projectId, f);
  }
  log(`[scenario:setup] seeded ${seedFiles.length} fixture files under project ${projectId}`);

  // Pre-recruit the Developer joined to this project (house pattern —
  // see fix-squisq-bugs). No hand-written about: the service resolves
  // the shipped Developer role template; task specifics live in the
  // kickoff message below.
  const dev = await provisionScenarioGezel(ctx, {
    preferredName: DEVELOPER_NAME,
    role: 'Developer',
    label: 'developer',
  });
  await client.addGezelToProject(projectId, dev.id);
  log(`[scenario:setup] joined ${dev.name} to project ${projectId}`);

  await client.sendChatMessage(dev.id, {
    message: trustedRunner ? `${KICKOFF_MESSAGE} ${TRUSTED_RUNNER_KICKOFF}` : KICKOFF_MESSAGE,
    projectId,
    ...(trustedRunner
      ? {
          expectedDeliverable: {
            kind: 'file' as const,
            filePath: MACHINE_PATH,
            scripts: [
              {
                name: 'checkWorkspaceScript',
                scope: 'standard' as const,
                inputs: {
                  script: TRUSTED_CHECK_PATH,
                  expectedSource: TRUSTED_CHECK_SOURCE,
                  timeoutMs: 120_000,
                },
              },
            ],
          },
        }
      : {}),
  });
  log(`[scenario:setup] sent kickoff to ${dev.name} in project ${projectId}`);
}

// ─────────────────────────────────────────────────────────────────────
// Grader machinery — pure helpers exported so the grader tests run
// without a daemon (the unwinnable-grader guard).

/** Tests file must be byte-identical to the seed (modulo trailing whitespace). */
export function detectTestsUntouched(testText: string | null): boolean {
  return testText !== null && testText.trim() === MACHINE_TEST_TS.trim();
}

export interface VitestRunResult {
  ok: boolean;
  exitCode: number | null;
  /** Verbatim ×/→/FAIL/AssertionError lines for the feedback channel. */
  failLines: string[];
  timedOut: boolean;
}

export interface TscRunResult {
  ok: boolean;
  exitCode: number | null;
  firstError?: string;
  timedOut: boolean;
}

/**
 * Pull the lines worth relaying to the model out of vitest's output:
 * `× <suite> > <test>` (stdout), `→ <assertion message>` (stdout),
 * `FAIL <file> > <test>` + `AssertionError: ...` + the `- Expected` /
 * `+ Received` diff lines (stderr). Deduped, capped.
 */
export function extractVitestFailureLines(stdout: string, stderr: string): string[] {
  const summaries: string[] = [];
  const details: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...stdout.split('\n'), ...stderr.split('\n')]) {
    const line = raw.trim();
    if (!line) continue;
    const interesting =
      /^[×✖]\s/.test(line) ||
      /^→\s/.test(line) ||
      /^FAIL\b/.test(line) ||
      /AssertionError/.test(line) ||
      // Collection errors: when the model's machine.ts throws at import
      // time, vitest prints `FAIL file [ file ]` plus an error block
      // (SyntaxError/ReferenceError/TypeError/Error: ...) that matches
      // none of the assertion patterns above. Wild-caught
      // baseline: all three trials degraded to a bare "FAIL
      // tests/machine.test.ts" with no cause, and the model iterated
      // blind until the watchdog killed it.
      /^(?:\w*Error|Caused by)[:\s]/.test(line) ||
      /^[-+]\s*(Expected|Received)/.test(line);
    if (!interesting || seen.has(line)) continue;
    seen.add(line);
    // Vitest 4 emits every short `× <test>` summary before the actionable
    // assertion/FAIL block. A suite with 12+ failures could therefore fill
    // the old cap before we captured even one error message or suite name.
    // Reserve most of the feedback budget for those details while retaining
    // a representative handful of failing test names.
    if (/^[×✖]\s/.test(line)) summaries.push(line);
    else details.push(line);
  }
  const out = [...summaries.slice(0, 4), ...details.slice(0, 8)];
  // Degraded-output fallback: only file-level FAIL lines and nothing
  // actionable — relay the head of stderr instead so the model sees the
  // actual load error rather than a bare filename.
  const hasDetail = out.some((l) => !/^FAIL\b/.test(l));
  if (!hasDetail) {
    const stderrHead = stderr
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 6);
    for (const line of stderrHead) {
      if (!seen.has(line)) {
        seen.add(line);
        out.push(line);
      }
    }
  }
  return out;
}

/**
 * Run the real vitest binary against a materialized workspace directory.
 * Returns null only on harness trouble (spawn failure with no exit code)
 * so callers can fall back rather than failing the trial on infra.
 */
export async function runVitestInDir(dir: string): Promise<VitestRunResult | null> {
  // Strip the parent vitest's worker env so the child run is clean, and
  // force CI/NO_COLOR so the reporter prints plain parseable lines.
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('VITEST')) continue;
    env[k] = v;
  }
  env.CI = 'true';
  env.NO_COLOR = '1';
  env.GEZEL_FAILING_TESTS_ROOT = dir;
  try {
    // Pin discovery to the seeded spec and ignore model-authored Vitest
    // config/setup files. The controlled config deliberately lives beside
    // this harness rather than inside the materialized workspace: on Windows,
    // Vitest/esbuild can fail to bundle a config on another drive or inside a
    // permission-restricted temp root before it ever discovers the tests.
    const result = await spawnAndAwait(
      process.execPath,
      [resolveVitestBin(), 'run', TEST_PATH, '--config', CONTROLLED_VITEST_CONFIG],
      {
        // Keep config bundling on the harness drive. `root` in the controlled
        // config still points discovery at the materialized workspace.
        cwd: dirname(CONTROLLED_VITEST_CONFIG),
        env,
        timeoutMs: 120_000,
      },
    );
    if (result.timedOut) {
      return {
        ok: false,
        exitCode: result.exitCode,
        failLines: ['vitest run timed out after 120s — check for an infinite loop in machine.ts'],
        timedOut: true,
      };
    }
    if (result.exitCode === null) return null;
    const fullOutput = `${result.stdout}\n${result.stderr}`;
    const allSeededTestsReported = new RegExp(
      `\\bTests\\s+${EXPECTED_TEST_COUNT}\\s+passed\\b`,
      'i',
    ).test(fullOutput);
    if (result.exitCode === 0 && allSeededTestsReported) {
      return { ok: true, exitCode: 0, failLines: [], timedOut: false };
    }
    if (result.exitCode === 0) {
      return {
        ok: false,
        exitCode: 0,
        failLines: [
          `vitest exited 0 without reporting all ${EXPECTED_TEST_COUNT} seeded tests passed — process exit/config bypass is not accepted`,
        ],
        timedOut: false,
      };
    }
    let failLines = extractVitestFailureLines(result.stdout, result.stderr);
    if (failLines.length === 0) {
      const firstErr = [...result.stderr.split('\n'), ...result.stdout.split('\n')]
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      failLines = [firstErr ? `vitest run failed: ${firstErr.slice(0, 200)}` : 'vitest run failed'];
    }
    return { ok: false, exitCode: result.exitCode, failLines, timedOut: false };
  } catch {
    return null;
  } finally {
    delete env.GEZEL_FAILING_TESTS_ROOT;
  }
}

/**
 * Compile the shipping TypeScript source with the strict seeded options.
 * Uses a harness-owned config so changing/excluding files in the workspace
 * tsconfig cannot turn a broken implementation into a green gate.
 */
export async function runTscInDir(dir: string): Promise<TscRunResult | null> {
  const controlledConfigPath = join(dir, '.gezel-eval-tsconfig.json');
  try {
    await writeFile(controlledConfigPath, TSC_GATE_CONFIG_JSON, 'utf8');
    const result = await spawnAndAwait(
      process.execPath,
      [resolveTscBin(), '--pretty', 'false', '--project', controlledConfigPath],
      {
        cwd: dir,
        timeoutMs: 120_000,
      },
    );
    if (result.timedOut) {
      return {
        ok: false,
        exitCode: result.exitCode,
        firstError: 'tsc --noEmit timed out after 120s',
        timedOut: true,
      };
    }
    if (result.exitCode === null) return null;
    if (result.exitCode === 0) {
      return { ok: true, exitCode: 0, timedOut: false };
    }
    const firstError = `${result.stdout}\n${result.stderr}`
      .split('\n')
      .map((line) => line.trim())
      .find((line) => /error TS\d+:/i.test(line));
    return {
      ok: false,
      exitCode: result.exitCode,
      firstError: firstError?.slice(0, 500) ?? 'tsc --noEmit failed without a parsed diagnostic',
      timedOut: false,
    };
  } catch {
    return null;
  } finally {
    await rm(controlledConfigPath, { force: true }).catch(() => {});
  }
}

export const FAILING_TESTS_SIGNALS = [
  'tests-untouched',
  'machine-implemented',
  'vitest-green',
  'tsc-clean',
];
const REQUIRED_SIGNALS = ['tests-untouched', 'vitest-green', 'tsc-clean'];

/**
 * Process guidance for a red test run. This deliberately names no expected
 * states, methods, or values: the frozen test file remains the only spec.
 * The important repair invariant is that a near-miss keeps the public
 * contract already demonstrated by those tests instead of replacing it with
 * a newly invented API on every retry.
 */
export const FAILING_TESTS_REPAIR_DIRECTIVE = [
  `Before editing, re-read ${TEST_PATH} in full and then read the current ${MACHINE_PATH}.`,
  `Patch ${MACHINE_PATH} against the API the frozen tests actually call: preserve the exported factory signature and the returned object's tested fields and methods instead of inventing a different interface or extra arguments.`,
  'Fix the first concrete Vitest or TypeScript compiler mismatch while keeping behavior that already passed; prefer replace_in_file/replace_lines for a localized correction.',
].join(' ');

export interface FailingTestsVerdict {
  ok: boolean;
  signals: string[];
  missingRequiredSignals: string[];
  failReason?: string;
  vitest: VitestRunResult | null;
  tsc: TscRunResult | null;
}

/**
 * Pure verdict composition shared by the live successCheck and the
 * directory-based verifier, so the two can't drift.
 */
export function composeFailingTestsVerdict(parts: {
  testText: string | null;
  machineText: string | null;
  vitest: VitestRunResult | null;
  tsc: TscRunResult | null;
}): FailingTestsVerdict {
  const { testText, machineText, vitest, tsc } = parts;
  const signals: string[] = [];
  const structuralFailures: string[] = [];
  const gateFailures: string[] = [];

  const testsUntouched = detectTestsUntouched(testText);
  if (testsUntouched) signals.push('tests-untouched');
  else if (testText === null)
    structuralFailures.push(
      `${TEST_PATH} is missing from the workspace — restore the seeded file exactly; the tests are the read-only spec`,
    );
  else
    structuralFailures.push(
      `${TEST_PATH} was modified — restore it to exactly the seeded version; the tests are the read-only spec and must not change`,
    );

  if (machineText !== null && machineText.trim() !== MACHINE_SKELETON_TS.trim()) {
    signals.push('machine-implemented');
  }
  if (machineText === null) {
    structuralFailures.push(
      `${MACHINE_PATH} is missing from the workspace — it must exist and be implemented`,
    );
  }

  if (vitest?.ok) {
    signals.push('vitest-green');
  } else if (vitest && !vitest.ok) {
    gateFailures.push(
      `vitest run failed (exit ${vitest.exitCode ?? 'none'}): ${vitest.failLines.slice(0, 8).join(' | ')}`.slice(
        0,
        VITEST_FAILURE_REASON_MAX_CHARS,
      ),
    );
  }

  if (tsc?.ok) {
    signals.push('tsc-clean');
  } else if (tsc && !tsc.ok) {
    const diagnostic =
      tsc.firstError?.replace(/\s+/g, ' ').trim().slice(0, TSC_DIAGNOSTIC_MAX_CHARS) ||
      'tsc --noEmit failed without a parsed diagnostic';
    gateFailures.push(`tsc --noEmit failed (exit ${tsc.exitCode ?? 'none'}): ${diagnostic}`);
  }

  const ok =
    signals.includes('tests-untouched') &&
    signals.includes('vitest-green') &&
    signals.includes('tsc-clean');
  return {
    ok,
    signals,
    missingRequiredSignals: REQUIRED_SIGNALS.filter((s) => !signals.includes(s)),
    // Structural integrity failures remain primary because quality gates are
    // not trusted against a rewritten/missing fixture. When both real gates
    // fail, retain their independently bounded details in one deterministic
    // line so the Vitest summary cannot hide the actionable strict-tsc error.
    failReason:
      structuralFailures[0] ?? (gateFailures.length > 0 ? gateFailures.join(' || ') : undefined),
    vitest,
    tsc,
  };
}

/**
 * Offline verification of a failing-tests-spec workspace DIRECTORY (no
 * daemon): tests-untouched guard + real `vitest run` and strict `tsc
 * --noEmit` gates. Used by the grader tests and by failure-class backfills.
 */
export async function verifyFailingTestsWorkspaceDir(dir: string): Promise<FailingTestsVerdict> {
  const testText = await readFile(join(dir, TEST_PATH), 'utf8').catch(() => null);
  const machineText = await readFile(join(dir, MACHINE_PATH), 'utf8').catch(() => null);
  // Don't run either quality gate against a rewritten spec — a model could
  // trivially green its own tests; the untouched gate already failed.
  let vitest: VitestRunResult | null = null;
  let tsc: TscRunResult | null = null;
  if (detectTestsUntouched(testText) && machineText !== null) {
    vitest = await runVitestInDir(dir);
    tsc = await runTscInDir(dir);
  }
  return composeFailingTestsVerdict({ testText, machineText, vitest, tsc });
}

// ─────────────────────────────────────────────────────────────────────

interface FailingTestsGateResult {
  vitest: VitestRunResult | null;
  tsc: TscRunResult | null;
}

const verificationGateCache = new WeakMap<
  EvalContext,
  { lastHash: string; lastResult: FailingTestsGateResult }
>();

async function runVerificationGates(
  ctx: EvalContext,
  client: GezelClient,
  projectId: string,
  contentHash: string,
  log: (line: string) => void,
): Promise<FailingTestsGateResult> {
  const cached = verificationGateCache.get(ctx);
  if (cached && cached.lastHash === contentHash) return cached.lastResult;
  const tmp = await mkdtemp(`${tmpdir()}/gezel-eval-machine-kata-`);
  try {
    await materializeProjectWorkspace(client, projectId, tmp, {
      include: /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/,
    });
    const vitest = await runVitestInDir(tmp);
    const tsc = await runTscInDir(tmp);
    if (vitest === null) {
      log('[scenario] vitest gate unavailable (harness error) — will retry next poll');
    } else {
      log(
        `[scenario] vitest gate: ok=${vitest.ok} exit=${vitest.exitCode}${
          vitest.failLines.length > 0 ? ` first="${vitest.failLines[0]?.slice(0, 120)}"` : ''
        }`,
      );
    }
    if (tsc === null) {
      log('[scenario] tsc gate unavailable (harness error) — will retry next poll');
    } else {
      log(
        `[scenario] tsc gate: ok=${tsc.ok} exit=${tsc.exitCode}${tsc.firstError ? ` first="${tsc.firstError.slice(0, 160)}"` : ''}`,
      );
    }
    const result = { vitest, tsc };
    // Harness failures are transient, so only cache a complete pair.
    if (vitest !== null && tsc !== null) {
      verificationGateCache.set(ctx, { lastHash: contentHash, lastResult: result });
    }
    return result;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

export const failingTestsSpecScenario: EvalScenario = {
  id: 'failing-tests-spec',
  description:
    'The vitest suite is the only behavioral specification: ~15 assertion-only cases pin a small order-lifecycle state machine; src/machine.ts is an empty skeleton. Implement it until `vitest run` and strict `tsc --noEmit` are green without touching anything under tests/.',
  prompt: [
    `Heads up: ${DEVELOPER_NAME} is implementing src/machine.ts against the read-only vitest spec`,
    `in the "${PROJECT_NAME}" project. You don't need to do anything — just confirm you've seen`,
    'this note.',
  ].join(' '),
  evidenceTexts: [KICKOFF_MESSAGE, MISSION_OBJECTIVES],
  timeoutMs: 25 * 60_000,
  progressTimeoutMs: 12 * 60_000,
  setup,
  skipInitialPrompt: true,
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const { client, log, logChanged, recordSniff } = ctx;
    const projectId = await findProjectId(client);
    if (!projectId) {
      logChanged('project', '[scenario] machine-kata project not present yet');
      return { done: false };
    }

    const [testText, machineText] = await Promise.all([
      readWorkspaceText(client, projectId, TEST_PATH),
      readWorkspaceText(client, projectId, MACHINE_PATH),
    ]);

    // The Vitest/tsc spawns are the expensive gates: run them only when the
    // relevant content changed since the last poll (content-hash cache),
    // and never against a rewritten spec.
    let vitest: VitestRunResult | null = null;
    let tsc: TscRunResult | null = null;
    if (detectTestsUntouched(testText) && machineText !== null) {
      try {
        const revision = await workspaceContentRevision(
          client,
          projectId,
          /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/,
        );
        ({ vitest, tsc } = await runVerificationGates(ctx, client, projectId, revision, log));
      } catch (error) {
        logChanged(
          'gate-revision',
          `[scenario] unable to fingerprint machine-kata workspace yet: ${String(error).slice(0, 180)}`,
        );
      }
    }

    const verdict = composeFailingTestsVerdict({ testText, machineText, vitest, tsc });
    const bytes = machineText?.length ?? 0;
    logChanged(
      'sniff',
      `[scenario] failing-tests-spec bytes=${bytes} score=${verdict.signals.length}/${FAILING_TESTS_SIGNALS.length} signals=${verdict.signals.join(',') || 'none'}${verdict.failReason ? ` failReason="${verdict.failReason}"` : ''}`,
    );
    recordSniff?.({
      key: 'failing-tests-spec',
      score: verdict.signals.length,
      bytes,
      ...(verdict.failReason ? { failReason: verdict.failReason } : {}),
    });

    if (verdict.ok) {
      return {
        done: true,
        success: true,
        reason: `vitest and strict tsc gates green with the seeded spec untouched (signals: ${verdict.signals.join(', ')})`,
      };
    }

    if (verdict.failReason) {
      const target = verdict.signals.includes('tests-untouched') ? MACHINE_PATH : TEST_PATH;

      // setup() dispatches the kickoff asynchronously. During the first poll,
      // the seeded skeleton can fail Vitest before the recipient turn is
      // visible through listInflightTurns(). Posting that expected failure
      // queues a stale repair behind the initial implementation; once it is
      // delivered, a local model may overwrite a much better first pass with
      // code aimed at the obsolete skeleton result. Give the initial turn its
      // natural chance to replace the seed. Mutated/missing tests still get an
      // immediate correction because that is a destructive spec change. The
      // grace is bounded so a model that genuinely does nothing still gets a
      // nudge after roughly two minutes at the normal poll cadence.
      if (target === MACHINE_PATH && !verdict.signals.includes('machine-implemented')) {
        const polls = (initialSkeletonPolls.get(ctx) ?? 0) + 1;
        initialSkeletonPolls.set(ctx, polls);
        if (polls < INITIAL_SKELETON_FEEDBACK_GRACE_POLLS) {
          logChanged(
            'feedback-grace',
            `[scenario] ${MACHINE_PATH} is still the seeded skeleton; deferring Vitest repair feedback while the initial implementation lands (${polls}/${INITIAL_SKELETON_FEEDBACK_GRACE_POLLS} polls)`,
          );
          return { done: false };
        }
      }

      const targetGezelId = await findDeveloperGezelId(client);
      await postSniffFeedback(
        ctx,
        target,
        {
          ok: false,
          signals: verdict.signals,
          score: verdict.signals.length,
          failReason: verdict.failReason,
          missingRequiredSignals: verdict.missingRequiredSignals,
        },
        {
          projectId,
          ...(targetGezelId ? { targetGezelId } : {}),
          sourceText:
            target === MACHINE_PATH ? (machineText ?? undefined) : (testText ?? undefined),
          ...(target === MACHINE_PATH ? { repairDirective: FAILING_TESTS_REPAIR_DIRECTIVE } : {}),
        },
      );
    }
    return { done: false };
  },
};
