import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { EvalContext } from '../types.ts';
import {
  FAILING_TESTS_REPAIR_DIRECTIVE,
  MACHINE_PATH,
  MACHINE_SKELETON_TS,
  MACHINE_TEST_TS,
  PKG_JSON,
  TEST_PATH,
  TRUSTED_CHECK_PATH,
  TRUSTED_CHECK_RUNNER_ENV,
  TRUSTED_CHECK_SOURCE,
  TSCONFIG_JSON,
  composeFailingTestsVerdict,
  detectTestsUntouched,
  extractVitestFailureLines,
  failingTestsSpecScenario,
  trustedCheckRunnerEnabled,
  verifyFailingTestsWorkspaceDir,
} from './failing-tests-spec.ts';

// A correct implementation of the spec the seeded tests pin — the
// reference solution that proves the grader is winnable. Written the
// way a model plausibly would (transition table + closure state).
const REFERENCE_MACHINE_TS = `export interface TransitionRecord {
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

const TRANSITIONS: Record<string, Record<string, string>> = {
  draft: { submit: 'pending', cancel: 'cancelled' },
  pending: { pay: 'paid', cancel: 'cancelled' },
  paid: { ship: 'shipped', cancel: 'cancelled', expedite: 'shipped' },
  shipped: { deliver: 'delivered' },
  delivered: {},
  cancelled: {},
};

export function createOrderMachine(options?: { expedited?: boolean }): OrderMachine {
  let state = 'draft';
  const history: TransitionRecord[] = [];
  const expedited = options?.expedited === true;
  const nextFor = (event: string): string | null => {
    if (event === 'expedite' && !expedited) return null;
    return TRANSITIONS[state]?.[event] ?? null;
  };
  return {
    get state() {
      return state;
    },
    get history() {
      return history;
    },
    can(event: string): boolean {
      return nextFor(event) !== null;
    },
    send(event: string): string {
      const next = nextFor(event);
      if (next === null) {
        throw new Error(
          'invalid transition: event "' + event + '" is not allowed in state "' + state + '"',
        );
      }
      history.push({ from: state, to: next, event });
      state = next;
      return next;
    },
  };
}
`;

// Runtime behavior stays identical to the reference, but strict compilation
// rejects the same class of `undefined`-under-Record error observed in the
// passing trial artifact.
const TYPE_DIRTY_MACHINE_TS = REFERENCE_MACHINE_TS.replace(
  'export function createOrderMachine(options?: { expedited?: boolean }): OrderMachine {',
  `const compileOnly: Record<string, string> = { invalid: undefined };
void compileOnly;

export function createOrderMachine(options?: { expedited?: boolean }): OrderMachine {`,
);

async function writeFixtureWorkspace(
  dir: string,
  machineTs: string,
  testTs: string = MACHINE_TEST_TS,
): Promise<void> {
  for (const [path, content] of [
    ['package.json', PKG_JSON],
    ['tsconfig.json', TSCONFIG_JSON],
    [TEST_PATH, testTs],
    [MACHINE_PATH, machineTs],
  ] as const) {
    const target = join(dir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

describe('failing-tests-spec: tests-untouched guard', () => {
  it('the seeded test file reads as untouched', () => {
    expect(detectTestsUntouched(MACHINE_TEST_TS)).toBe(true);
  });

  it('trailing-whitespace round-trips still read as untouched', () => {
    expect(detectTestsUntouched(`${MACHINE_TEST_TS}\n`)).toBe(true);
  });

  it('a modified test file reads as touched', () => {
    expect(detectTestsUntouched(MACHINE_TEST_TS.replace("'draft'", "'open'"))).toBe(false);
  });

  it('a missing test file reads as touched', () => {
    expect(detectTestsUntouched(null)).toBe(false);
  });
});

describe('failing-tests-spec: trusted checker treatment', () => {
  it('enables only for the explicit eval arm value', () => {
    expect(trustedCheckRunnerEnabled({ [TRUSTED_CHECK_RUNNER_ENV]: '1' })).toBe(true);
    expect(trustedCheckRunnerEnabled({ [TRUSTED_CHECK_RUNNER_ENV]: '0' })).toBe(false);
    expect(trustedCheckRunnerEnabled({})).toBe(false);
  });

  it('seeds and pins the checker on the treatment arm', async () => {
    vi.stubEnv(TRUSTED_CHECK_RUNNER_ENV, '1');
    try {
      const client = {
        listProjects: vi.fn().mockResolvedValue({
          projects: [{ id: 'machine-project', name: 'Machine Kata' }],
        }),
        writeProjectWorkspaceFile: vi.fn().mockResolvedValue({}),
        listGezels: vi.fn().mockResolvedValue({
          gezels: [{ id: 'priya-gezel', name: 'Priya', role: 'Developer' }],
        }),
        addGezelToProject: vi.fn().mockResolvedValue({}),
        sendChatMessage: vi.fn().mockResolvedValue({ accepted: true }),
      };
      const ctx = {
        client,
        meesterId: 'meester',
        log: vi.fn(),
      } as unknown as EvalContext;

      await failingTestsSpecScenario.setup?.(ctx);

      expect(client.writeProjectWorkspaceFile).toHaveBeenCalledWith('machine-project', {
        path: TRUSTED_CHECK_PATH,
        content: TRUSTED_CHECK_SOURCE,
      });
      expect(client.sendChatMessage).toHaveBeenCalledWith(
        'priya-gezel',
        expect.objectContaining({
          projectId: 'machine-project',
          message: expect.stringContaining('trusted checker'),
          expectedDeliverable: {
            kind: 'file',
            filePath: MACHINE_PATH,
            scripts: [
              {
                name: 'checkWorkspaceScript',
                scope: 'standard',
                inputs: {
                  script: TRUSTED_CHECK_PATH,
                  expectedSource: TRUSTED_CHECK_SOURCE,
                  timeoutMs: 120_000,
                },
              },
            ],
          },
        }),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('failing-tests-spec: vitest failure-line extraction', () => {
  it('picks up ×, →, FAIL, and AssertionError lines verbatim', () => {
    const stdout = [
      ' ❯ tests/machine.test.ts (15 tests | 15 failed) 12ms',
      '   × order machine: initial state > starts in "draft" 2ms',
      '     → createOrderMachine is not implemented yet',
      '',
    ].join('\n');
    const stderr = [
      ' FAIL  tests/machine.test.ts > order machine: initial state > starts in "draft"',
      'AssertionError: expected undefined to be defined',
    ].join('\n');
    const lines = extractVitestFailureLines(stdout, stderr);
    expect(lines).toContain('× order machine: initial state > starts in "draft" 2ms');
    expect(lines).toContain('→ createOrderMachine is not implemented yet');
    expect(lines).toContain(
      'FAIL  tests/machine.test.ts > order machine: initial state > starts in "draft"',
    );
    expect(lines).toContain('AssertionError: expected undefined to be defined');
  });
});

describe('failing-tests-spec: grader verdict vs the SEEDED state', () => {
  it('the seeded skeleton FAILS vitest and the verdict says exactly what is missing', async () => {
    const tmp = await mkdtemp(`${tmpdir()}/failing-tests-spec-seed-`);
    try {
      await writeFixtureWorkspace(tmp, MACHINE_SKELETON_TS);
      const verdict = await verifyFailingTestsWorkspaceDir(tmp);
      expect(verdict.ok).toBe(false);
      // The spec is untouched; only the green run is missing.
      expect(verdict.signals).toContain('tests-untouched');
      expect(verdict.signals).not.toContain('machine-implemented');
      expect(verdict.missingRequiredSignals).toEqual(['vitest-green']);
      // Failing test names + assertion lines are relayed verbatim.
      expect(verdict.vitest).not.toBeNull();
      expect(verdict.vitest?.ok).toBe(false);
      expect(verdict.vitest?.failLines.length).toBeGreaterThan(0);
      const joined = verdict.vitest?.failLines.join('\n') ?? '';
      expect(joined).toMatch(/order machine/);
      expect(joined).toMatch(/not implemented/);
      expect(verdict.failReason).toMatch(/vitest run failed/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it('a rewritten spec fails the REQUIRED tests-untouched signal and vitest is not consulted', async () => {
    const tmp = await mkdtemp(`${tmpdir()}/failing-tests-spec-rewrite-`);
    try {
      const gamedSpec =
        "import { it, expect } from 'vitest';\nit('trivial', () => { expect(1).toBe(1); });\n";
      await writeFixtureWorkspace(tmp, MACHINE_SKELETON_TS, gamedSpec);
      const verdict = await verifyFailingTestsWorkspaceDir(tmp);
      expect(verdict.ok).toBe(false);
      expect(verdict.missingRequiredSignals).toContain('tests-untouched');
      expect(verdict.vitest).toBeNull();
      expect(verdict.failReason).toMatch(/was modified/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it('does not accept a source module that exits the test process with code zero', async () => {
    const tmp = await mkdtemp(`${tmpdir()}/failing-tests-spec-process-exit-`);
    try {
      await writeFixtureWorkspace(tmp, 'process.exit(0);\n');
      const verdict = await verifyFailingTestsWorkspaceDir(tmp);
      expect(verdict.ok).toBe(false);
      expect(verdict.vitest?.ok).toBe(false);
      expect(verdict.vitest?.failLines.join('\n')).toMatch(
        /process\.exit|without reporting all 17 seeded tests/,
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it('ignores a model-authored Vitest config that excludes the seeded spec', async () => {
    const tmp = await mkdtemp(`${tmpdir()}/failing-tests-spec-config-bypass-`);
    try {
      await writeFixtureWorkspace(tmp, REFERENCE_MACHINE_TS);
      await writeFile(
        join(tmp, 'vitest.config.ts'),
        "export default { test: { exclude: ['**/*'], passWithNoTests: true } };\n",
        'utf8',
      );
      const verdict = await verifyFailingTestsWorkspaceDir(tmp);
      expect(verdict.ok).toBe(true);
      expect(verdict.vitest?.ok).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('failing-tests-spec: grader verdict vs the REFERENCE solution', () => {
  it('a correct implementation PASSES vitest, strict tsc, and the full verdict', async () => {
    const tmp = await mkdtemp(`${tmpdir()}/failing-tests-spec-ref-`);
    try {
      await writeFixtureWorkspace(tmp, REFERENCE_MACHINE_TS);
      const verdict = await verifyFailingTestsWorkspaceDir(tmp);
      expect(verdict.vitest).not.toBeNull();
      expect(verdict.vitest?.failLines ?? []).toEqual([]);
      expect(verdict.vitest?.ok).toBe(true);
      expect(verdict.tsc?.ok).toBe(true);
      expect(verdict.signals).toContain('tests-untouched');
      expect(verdict.signals).toContain('machine-implemented');
      expect(verdict.signals).toContain('vitest-green');
      expect(verdict.signals).toContain('tsc-clean');
      expect(verdict.missingRequiredSignals).toEqual([]);
      expect(verdict.ok).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it('rejects runtime-green source with a strict Record/undefined compiler error', async () => {
    const tmp = await mkdtemp(`${tmpdir()}/failing-tests-spec-tsc-dirty-`);
    try {
      await writeFixtureWorkspace(tmp, TYPE_DIRTY_MACHINE_TS);
      const verdict = await verifyFailingTestsWorkspaceDir(tmp);
      expect(verdict.vitest?.ok).toBe(true);
      expect(verdict.tsc?.ok).toBe(false);
      expect(verdict.tsc?.firstError).toMatch(/TS2322/);
      expect(verdict.signals).toContain('vitest-green');
      expect(verdict.signals).not.toContain('tsc-clean');
      expect(verdict.missingRequiredSignals).toEqual(['tsc-clean']);
      expect(verdict.failReason).toMatch(/tsc --noEmit failed/);
      expect(verdict.ok).toBe(false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it('a near-miss (wrong error message) fails with the failing test relayed by name', async () => {
    const wrongMessage = REFERENCE_MACHINE_TS.replace(
      "'invalid transition: event \"' + event + '\" is not allowed in state \"' + state + '\"'",
      "'bad transition: ' + event",
    );
    expect(wrongMessage).not.toBe(REFERENCE_MACHINE_TS);
    const tmp = await mkdtemp(`${tmpdir()}/failing-tests-spec-miss-`);
    try {
      await writeFixtureWorkspace(tmp, wrongMessage);
      const verdict = await verifyFailingTestsWorkspaceDir(tmp);
      expect(verdict.ok).toBe(false);
      expect(verdict.missingRequiredSignals).toEqual(['vitest-green']);
      const joined = verdict.vitest?.failLines.join('\n') ?? '';
      expect(joined).toMatch(/invalid transition/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('failing-tests-spec: verdict composition edge cases', () => {
  it('a missing machine.ts is named in the failReason', () => {
    const verdict = composeFailingTestsVerdict({
      testText: MACHINE_TEST_TS,
      machineText: null,
      vitest: null,
      tsc: null,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failReason).toMatch(/src\/machine\.ts is missing/);
  });

  it('a vitest timeout is surfaced as a model-facing failure, not a pass', () => {
    const verdict = composeFailingTestsVerdict({
      testText: MACHINE_TEST_TS,
      machineText: REFERENCE_MACHINE_TS,
      vitest: { ok: false, exitCode: null, failLines: ['vitest run timed out'], timedOut: true },
      tsc: { ok: true, exitCode: 0, timedOut: false },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failReason).toMatch(/timed out/);
  });

  it('keeps bounded Vitest detail and the actionable strict-tsc diagnostic on a dual failure', () => {
    const firstVitestLine = '× service contract > returns its declared value';
    const verdict = composeFailingTestsVerdict({
      testText: MACHINE_TEST_TS,
      machineText: 'export const implementation = true;\n',
      vitest: {
        ok: false,
        exitCode: 1,
        failLines: [
          firstVitestLine,
          ...Array.from(
            { length: 11 },
            (_, index) => `→ synthetic assertion ${index}: ${'v'.repeat(200)}`,
          ),
        ],
        timedOut: false,
      },
      tsc: {
        ok: false,
        exitCode: 2,
        firstError: `src/example.ts(12,3): error TS2355: declared non-void function must return a value ${'t'.repeat(900)}`,
        timedOut: false,
      },
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.missingRequiredSignals).toEqual(['vitest-green', 'tsc-clean']);
    expect(verdict.failReason).toContain(firstVitestLine);
    expect(verdict.failReason).toMatch(/\|\| tsc --noEmit failed \(exit 2\): .*TS2355/);
    expect(verdict.failReason).not.toContain('synthetic assertion 8');
    expect(verdict.failReason?.length).toBeLessThanOrEqual(1_500);
    expect(
      composeFailingTestsVerdict({
        testText: MACHINE_TEST_TS,
        machineText: 'export const implementation = true;\n',
        vitest: {
          ok: false,
          exitCode: 1,
          failLines: [
            firstVitestLine,
            ...Array.from(
              { length: 11 },
              (_, index) => `→ synthetic assertion ${index}: ${'v'.repeat(200)}`,
            ),
          ],
          timedOut: false,
        },
        tsc: {
          ok: false,
          exitCode: 2,
          firstError: `src/example.ts(12,3): error TS2355: declared non-void function must return a value ${'t'.repeat(900)}`,
          timedOut: false,
        },
      }).failReason,
    ).toBe(verdict.failReason);
  });

  it('preserves Vitest-only feedback without adding a compiler failure', () => {
    const verdict = composeFailingTestsVerdict({
      testText: MACHINE_TEST_TS,
      machineText: 'export const implementation = true;\n',
      vitest: {
        ok: false,
        exitCode: 1,
        failLines: [
          '× service contract > reports the current status',
          '→ expected false to be true',
        ],
        timedOut: false,
      },
      tsc: { ok: true, exitCode: 0, timedOut: false },
    });

    expect(verdict.missingRequiredSignals).toEqual(['vitest-green']);
    expect(verdict.failReason).toBe(
      'vitest run failed (exit 1): × service contract > reports the current status | → expected false to be true',
    );
  });

  it('surfaces a strict-tsc-only diagnostic when Vitest is green', () => {
    const verdict = composeFailingTestsVerdict({
      testText: MACHINE_TEST_TS,
      machineText: 'export const implementation = true;\n',
      vitest: { ok: true, exitCode: 0, failLines: [], timedOut: false },
      tsc: {
        ok: false,
        exitCode: 2,
        firstError:
          "src/example.ts(7,9): error TS2451: Cannot redeclare block-scoped variable 'value'.",
        timedOut: false,
      },
    });

    expect(verdict.missingRequiredSignals).toEqual(['tsc-clean']);
    expect(verdict.failReason).toBe(
      "tsc --noEmit failed (exit 2): src/example.ts(7,9): error TS2451: Cannot redeclare block-scoped variable 'value'.",
    );
  });

  it('leaves failReason unset when the reference gates pass', () => {
    const verdict = composeFailingTestsVerdict({
      testText: MACHINE_TEST_TS,
      machineText: 'export const implementation = true;\n',
      vitest: { ok: true, exitCode: 0, failLines: [], timedOut: false },
      tsc: { ok: true, exitCode: 0, timedOut: false },
    });

    expect(verdict.ok).toBe(true);
    expect(verdict.missingRequiredSignals).toEqual([]);
    expect(verdict.failReason).toBeUndefined();
  });
});

describe('failing-tests-spec: feedback routing', () => {
  it('does not queue a stale failure while the initial seeded skeleton is still being implemented', async () => {
    const client = {
      listProjects: vi.fn().mockResolvedValue({
        projects: [{ id: 'machine-project', name: 'Machine Kata' }],
      }),
      listGezels: vi.fn().mockResolvedValue({
        gezels: [{ id: 'priya-gezel', name: 'Priya', role: 'Developer' }],
      }),
      listProjectWorkspace: vi.fn().mockResolvedValue({
        files: [
          { path: 'package.json', isDirectory: false },
          { path: 'tsconfig.json', isDirectory: false },
          { path: TEST_PATH, isDirectory: false },
          { path: MACHINE_PATH, isDirectory: false },
        ],
      }),
      fetchProjectWorkspaceBlob: vi.fn(async (_projectId: string, path: string) => {
        const content =
          path === 'package.json'
            ? PKG_JSON
            : path === 'tsconfig.json'
              ? TSCONFIG_JSON
              : path === TEST_PATH
                ? MACHINE_TEST_TS
                : path === MACHINE_PATH
                  ? MACHINE_SKELETON_TS
                  : undefined;
        if (content === undefined) throw new Error(`unexpected path ${path}`);
        return new Blob([content]);
      }),
      listChatSessions: vi.fn().mockResolvedValue({ sessions: [] }),
      listInflightTurns: vi.fn().mockResolvedValue({ inflight: [] }),
      messageGezel: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const logChanged = vi.fn();
    const ctx = {
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged,
      recordSniff: vi.fn(),
    } as unknown as EvalContext;

    const result = await failingTestsSpecScenario.successCheck(ctx);

    expect(result).toEqual({ done: false });
    expect(client.messageGezel).not.toHaveBeenCalled();
    expect(logChanged).toHaveBeenCalledWith(
      'feedback-grace',
      expect.stringContaining('still the seeded skeleton'),
    );

    // The grace must not become a silent permanent stall if the recipient
    // never writes. The cached Vitest result makes these repeat polls cheap.
    for (let poll = 1; poll < 24; poll += 1) {
      await failingTestsSpecScenario.successCheck(ctx);
    }
    expect(client.messageGezel).toHaveBeenCalledWith(
      'priya-gezel',
      expect.objectContaining({
        expectedDeliverable: { kind: 'file', filePath: MACHINE_PATH },
        text: expect.stringContaining(FAILING_TESTS_REPAIR_DIRECTIVE),
      }),
    );
  });

  it('grounds implementation repair in the frozen test contract without revealing its answer', () => {
    expect(FAILING_TESTS_REPAIR_DIRECTIVE).toContain(`re-read ${TEST_PATH} in full`);
    expect(FAILING_TESTS_REPAIR_DIRECTIVE).toContain('preserve the exported factory signature');
    expect(FAILING_TESTS_REPAIR_DIRECTIVE).toContain('prefer replaceInFile/replaceLines');
    expect(FAILING_TESTS_REPAIR_DIRECTIVE).not.toMatch(/cancelled|expedite|invalid transition/);
  });

  it('routes a runtime-green strict compiler failure back to the source author', async () => {
    const client = {
      listProjects: vi.fn().mockResolvedValue({
        projects: [{ id: 'machine-project', name: 'Machine Kata' }],
      }),
      listGezels: vi.fn().mockResolvedValue({
        gezels: [{ id: 'priya-gezel', name: 'Priya', role: 'Developer' }],
      }),
      listProjectWorkspace: vi.fn().mockResolvedValue({
        files: [
          { path: 'package.json', isDirectory: false },
          { path: 'tsconfig.json', isDirectory: false },
          { path: TEST_PATH, isDirectory: false },
          { path: MACHINE_PATH, isDirectory: false },
        ],
      }),
      fetchProjectWorkspaceBlob: vi.fn(async (_projectId: string, path: string) => {
        const content =
          path === 'package.json'
            ? PKG_JSON
            : path === 'tsconfig.json'
              ? TSCONFIG_JSON
              : path === TEST_PATH
                ? MACHINE_TEST_TS
                : path === MACHINE_PATH
                  ? TYPE_DIRTY_MACHINE_TS
                  : undefined;
        if (content === undefined) throw new Error(`unexpected path ${path}`);
        return new Blob([content]);
      }),
      listChatSessions: vi.fn().mockResolvedValue({ sessions: [] }),
      listInflightTurns: vi.fn().mockResolvedValue({ inflight: [] }),
      messageGezel: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const recordSniff = vi.fn();

    const result = await failingTestsSpecScenario.successCheck({
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
      recordSniff,
    } as unknown as EvalContext);

    expect(result).toEqual({ done: false });
    expect(recordSniff).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'failing-tests-spec', score: 3 }),
    );
    expect(client.messageGezel).toHaveBeenCalledWith(
      'priya-gezel',
      expect.objectContaining({
        expectedDeliverable: { kind: 'file', filePath: MACHINE_PATH },
        text: expect.stringMatching(/tsc-clean[\s\S]*tsc --noEmit failed[\s\S]*TS2322/),
      }),
    );
  }, 60_000);

  it('pins repair feedback to Priya in the machine-kata project even without an active worker session', async () => {
    const client = {
      listProjects: vi.fn().mockResolvedValue({
        projects: [{ id: 'machine-project', name: 'Machine Kata' }],
      }),
      listGezels: vi.fn().mockResolvedValue({
        gezels: [{ id: 'priya-gezel', name: 'Priya', role: 'Developer' }],
      }),
      fetchProjectWorkspaceBlob: vi.fn(async (_projectId: string, path: string) => {
        if (path === TEST_PATH) return new Blob([MACHINE_TEST_TS.replace("'draft'", "'open'")]);
        if (path === MACHINE_PATH) return new Blob([MACHINE_SKELETON_TS]);
        throw new Error(`unexpected path ${path}`);
      }),
      listChatSessions: vi.fn().mockResolvedValue({ sessions: [] }),
      listInflightTurns: vi.fn().mockResolvedValue({ inflight: [] }),
      messageGezel: vi.fn().mockResolvedValue({ accepted: true }),
    };

    const result = await failingTestsSpecScenario.successCheck({
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
      recordSniff: vi.fn(),
    } as unknown as EvalContext);

    expect(result).toEqual({ done: false });
    expect(client.messageGezel).toHaveBeenCalledWith(
      'priya-gezel',
      expect.objectContaining({
        fromGezelId: 'meester',
        projectId: 'machine-project',
        expectedDeliverable: { kind: 'file', filePath: TEST_PATH },
        text: expect.stringContaining(`${TEST_PATH} was modified`),
      }),
    );
  });
});
