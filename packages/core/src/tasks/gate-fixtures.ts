/**
 * The rows every host's gate tests share.
 *
 * Gate accounting and gate-script verdicts are pure decisions both hosts
 * make about the same records. Keeping the cases in one table means a
 * difference between the hosts shows up as a failing row, not as two suites
 * that each pass their own idea of the rules.
 */
import { GATE_DEFAULT_MAX_ATTEMPTS, GATE_MAX_PROGRESS_ATTEMPTS } from '../schemas/gate.js';

export interface GateFixture {
  name: string;
  /** Declared step ids, for routing validation. */
  steps: readonly string[];
  stepId: string;
  gate: { maxAttempts: number; onReject?: string };
  prior: { gateAttempts?: number; gateProgressAttempts?: number };
  verdict: { infrastructureError?: boolean; goto?: string; converging?: boolean };
  expect: {
    attempt: number;
    maxAttempts: number;
    paused: boolean;
    routeTo?: string;
    preserveGateBudget: boolean;
    unknownRoute?: string;
  };
}

const steps = ['build', 'review', 'done'] as const;

export const GATE_FIXTURES: readonly GateFixture[] = [
  {
    name: 'a rejection charges one attempt',
    steps,
    stepId: 'build',
    gate: { maxAttempts: GATE_DEFAULT_MAX_ATTEMPTS },
    prior: {},
    verdict: {},
    expect: {
      attempt: 1,
      maxAttempts: GATE_DEFAULT_MAX_ATTEMPTS,
      paused: false,
      preserveGateBudget: false,
    },
  },
  {
    name: 'an infrastructure failure charges nothing and pauses',
    steps,
    stepId: 'build',
    gate: { maxAttempts: GATE_DEFAULT_MAX_ATTEMPTS },
    prior: { gateAttempts: 2 },
    verdict: { infrastructureError: true },
    expect: {
      attempt: 2,
      maxAttempts: GATE_DEFAULT_MAX_ATTEMPTS,
      paused: true,
      preserveGateBudget: false,
    },
  },
  {
    name: 'routing back to the same step keeps the budget',
    steps,
    stepId: 'build',
    gate: { maxAttempts: GATE_DEFAULT_MAX_ATTEMPTS, onReject: 'build' },
    prior: { gateAttempts: 1 },
    verdict: {},
    expect: {
      attempt: 2,
      maxAttempts: GATE_DEFAULT_MAX_ATTEMPTS,
      paused: false,
      routeTo: 'build',
      preserveGateBudget: true,
    },
  },
  {
    name: 'routing to another step starts it fresh',
    steps,
    stepId: 'review',
    gate: { maxAttempts: GATE_DEFAULT_MAX_ATTEMPTS, onReject: 'build' },
    prior: { gateAttempts: 1 },
    verdict: {},
    expect: {
      attempt: 2,
      maxAttempts: GATE_DEFAULT_MAX_ATTEMPTS,
      paused: false,
      routeTo: 'build',
      preserveGateBudget: false,
    },
  },
  {
    name: 'a verdict goto wins over the declared onReject',
    steps,
    stepId: 'review',
    gate: { maxAttempts: GATE_DEFAULT_MAX_ATTEMPTS, onReject: 'build' },
    prior: {},
    verdict: { goto: 'done' },
    expect: {
      attempt: 1,
      maxAttempts: GATE_DEFAULT_MAX_ATTEMPTS,
      paused: false,
      routeTo: 'done',
      preserveGateBudget: false,
    },
  },
  {
    name: 'the last attempt exhausts the budget and pauses without routing',
    steps,
    stepId: 'build',
    gate: { maxAttempts: GATE_DEFAULT_MAX_ATTEMPTS, onReject: 'build' },
    prior: { gateAttempts: GATE_DEFAULT_MAX_ATTEMPTS - 1 },
    verdict: {},
    expect: {
      attempt: GATE_DEFAULT_MAX_ATTEMPTS,
      maxAttempts: GATE_DEFAULT_MAX_ATTEMPTS,
      paused: true,
      preserveGateBudget: false,
    },
  },
  {
    name: 'a converging rejection charges progress, not the attempt budget',
    steps,
    stepId: 'build',
    gate: { maxAttempts: GATE_DEFAULT_MAX_ATTEMPTS },
    prior: { gateAttempts: 2, gateProgressAttempts: 1 },
    verdict: { converging: true },
    expect: {
      attempt: 2,
      maxAttempts: GATE_DEFAULT_MAX_ATTEMPTS,
      paused: false,
      preserveGateBudget: false,
    },
  },
  {
    name: 'converging rejections still run out',
    steps,
    stepId: 'build',
    gate: { maxAttempts: GATE_DEFAULT_MAX_ATTEMPTS },
    prior: { gateAttempts: 1, gateProgressAttempts: GATE_MAX_PROGRESS_ATTEMPTS - 1 },
    verdict: { converging: true },
    expect: {
      attempt: 1,
      maxAttempts: GATE_DEFAULT_MAX_ATTEMPTS,
      paused: true,
      preserveGateBudget: false,
    },
  },
  {
    name: 'a goto naming no declared step is a configuration fault',
    steps,
    stepId: 'build',
    gate: { maxAttempts: GATE_DEFAULT_MAX_ATTEMPTS },
    prior: {},
    verdict: { goto: 'ghost' },
    expect: {
      attempt: 1,
      maxAttempts: GATE_DEFAULT_MAX_ATTEMPTS,
      paused: false,
      preserveGateBudget: false,
      unknownRoute: 'ghost',
    },
  },
];

export interface GateScriptRunFixture {
  status: 'ok' | 'error';
  output?: unknown;
  error?: string;
}

export interface GateScriptFixture {
  name: string;
  /** In order; `'skipped'` stands for a script the host declined to run. */
  runs: ReadonlyArray<GateScriptRunFixture | 'skipped' | 'throws'>;
  expect: {
    decision: 'approve' | 'reject';
    goto?: string;
    message?: string;
    infrastructureError?: true;
    skipped: number;
  };
}

export const GATE_SCRIPT_FIXTURES: readonly GateScriptFixture[] = [
  {
    name: 'no scripts approve',
    runs: [],
    expect: { decision: 'approve', skipped: 0 },
  },
  {
    name: 'the first rejection stops the chain',
    runs: [
      { status: 'ok', output: { decision: 'reject', message: 'Needs a title' } },
      { status: 'ok', output: { decision: 'approve', goto: 'done' } },
    ],
    expect: { decision: 'reject', message: 'Needs a title', skipped: 0 },
  },
  {
    name: 'the last approving goto wins',
    runs: [
      { status: 'ok', output: { decision: 'approve', goto: 'review' } },
      { status: 'ok', output: { decision: 'approve', goto: 'done' } },
    ],
    expect: { decision: 'approve', goto: 'done', skipped: 0 },
  },
  {
    name: 'a skipped script is fail-open',
    runs: ['skipped', { status: 'ok', output: { decision: 'approve' } }],
    expect: { decision: 'approve', skipped: 1 },
  },
  {
    name: 'a script that cannot run is an infrastructure fault',
    runs: ['throws'],
    expect: { decision: 'reject', infrastructureError: true, skipped: 0 },
  },
  {
    name: 'a script that fails is an infrastructure fault',
    runs: [{ status: 'error', error: 'TypeError: boom' }],
    expect: { decision: 'reject', infrastructureError: true, skipped: 0 },
  },
  {
    name: 'an invalid verdict is an infrastructure fault',
    runs: [{ status: 'ok', output: { decision: 'maybe' } }],
    expect: { decision: 'reject', infrastructureError: true, skipped: 0 },
  },
];
