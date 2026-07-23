import type { NormalizedStepGate, ScriptRun } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import type { GateWorkspaceReader } from './gate-eval.js';
import { evaluateStepGate, gateMessageFingerprint } from './step-gate.js';

function gate(partial: Partial<NormalizedStepGate>): NormalizedStepGate {
  return {
    at: 'completion',
    checks: [],
    scripts: [],
    maxAttempts: 4,
    legacy: false,
    ...partial,
  };
}

function ws(files: Record<string, string> = {}): GateWorkspaceReader {
  return {
    read: async (f) => files[f] ?? null,
    list: async () => Object.keys(files),
  };
}

function okRun(output: unknown): ScriptRun {
  return {
    id: 'run-1',
    projectId: 'p',
    scriptName: 's',
    startedAt: '2026-01-01T00:00:00Z',
    status: 'ok',
    trigger: { kind: 'manual', userInitiated: true },
    inputs: {},
    output,
    calls: [],
    logs: '',
  };
}

describe('evaluateStepGate', () => {
  it('rejects on a failed check WITHOUT running any script', async () => {
    const runScript = vi.fn();
    const outcome = await evaluateStepGate({
      gate: gate({
        checks: [{ kind: 'minBytes', file: 'index.html', bytes: 100 }],
        scripts: [{ name: 'never-runs' }],
      }),
      ws: ws({ 'index.html': 'tiny' }),
      runScript,
    });
    expect(outcome.decision).toBe('reject');
    expect(outcome.message).toContain('index.html is 4 bytes');
    expect(runScript).not.toHaveBeenCalled();
  });

  it('first script reject short-circuits with its message and goto', async () => {
    const calls: string[] = [];
    const outcome = await evaluateStepGate({
      gate: gate({ scripts: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }),
      ws: ws(),
      runScript: async (ref) => {
        calls.push(ref.name);
        if (ref.name === 'b') {
          return okRun({ decision: 'reject', message: 'fix the title screen', goto: 'design' });
        }
        return okRun({ decision: 'approve' });
      },
    });
    expect(outcome.decision).toBe('reject');
    expect(outcome.message).toBe('fix the title screen');
    expect(outcome.goto).toBe('design');
    expect(calls).toEqual(['a', 'b']);
  });

  it('all approve → approve; LAST goto and handoff win', async () => {
    const outcome = await evaluateStepGate({
      gate: gate({ scripts: [{ name: 'a' }, { name: 'b' }] }),
      ws: ws(),
      runScript: async (ref) =>
        ref.name === 'a'
          ? okRun({ decision: 'approve', goto: 'x', handoff: { message: 'first' } })
          : okRun({ decision: 'approve', goto: 'y', handoff: { message: 'second' } }),
    });
    expect(outcome.decision).toBe('approve');
    expect(outcome.goto).toBe('y');
    expect(outcome.handoff?.message).toBe('second');
  });

  it('script error and invalid output fail closed as infrastructure errors', async () => {
    const errored = await evaluateStepGate({
      gate: gate({ scripts: [{ name: 'boom' }] }),
      ws: ws(),
      runScript: async () => ({ ...okRun(undefined), status: 'error', error: 'exploded' }),
    });
    expect(errored.decision).toBe('reject');
    expect(errored.message).toContain('boom');
    expect(errored.message).toContain('exploded');
    expect(errored.infrastructureError).toBe(true);

    const invalid = await evaluateStepGate({
      gate: gate({ scripts: [{ name: 'weird' }] }),
      ws: ws(),
      runScript: async () => okRun({ totally: 'not a gate result' }),
    });
    expect(invalid.decision).toBe('reject');
    expect(invalid.message).toContain('invalid result');
    expect(invalid.infrastructureError).toBe(true);
  });

  it('a reject without a message is fail-closed too (schema enforces message)', async () => {
    const outcome = await evaluateStepGate({
      gate: gate({ scripts: [{ name: 'mute' }] }),
      ws: ws(),
      runScript: async () => okRun({ decision: 'reject' }),
    });
    expect(outcome.decision).toBe('reject');
    expect(outcome.message).toContain('invalid result');
  });

  it('skipped scripts fail-open: approve with the skips reported', async () => {
    const outcome = await evaluateStepGate({
      gate: gate({
        checks: [{ kind: 'minBytes', file: 'a.txt', bytes: 1 }],
        scripts: [{ name: 'user-script' }, { name: 'std', scope: 'standard' }],
      }),
      ws: ws({ 'a.txt': 'content' }),
      runScript: async (ref) =>
        ref.scope === 'standard' ? okRun({ decision: 'approve' }) : 'skipped',
    });
    expect(outcome.decision).toBe('approve');
    expect(outcome.skipped).toEqual(['user-script']);
  });

  it('runScript throwing rejects with a diagnostic', async () => {
    const outcome = await evaluateStepGate({
      gate: gate({ scripts: [{ name: 'missing', scope: 'standard' }] }),
      ws: ws(),
      runScript: async () => {
        throw new Error('ENOENT: no such script');
      },
    });
    expect(outcome.decision).toBe('reject');
    expect(outcome.message).toContain('could not run');
    expect(outcome.infrastructureError).toBe(true);
  });
});

describe('gateMessageFingerprint', () => {
  it('is stable for equal text and differs for different text', () => {
    expect(gateMessageFingerprint('abc')).toBe(gateMessageFingerprint('abc'));
    expect(gateMessageFingerprint('abc')).not.toBe(gateMessageFingerprint('abd'));
  });
});
