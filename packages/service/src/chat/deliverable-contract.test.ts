import type { ScriptRun } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { GateWorkspaceReader } from '../tasks/gate-eval.js';
import type { GateScriptExecutor } from '../tasks/step-gate.js';
import { evaluateDeliverableContract } from './deliverable-contract.js';

function ws(files: Record<string, string>): GateWorkspaceReader {
  return {
    read: async (f) => files[f] ?? null,
    list: async () => Object.keys(files),
  };
}

const okRun = (name: string, output: unknown): ScriptRun =>
  ({
    id: 'r1',
    projectId: 'p',
    scriptName: name,
    startedAt: '',
    status: 'ok',
    output,
  }) as unknown as ScriptRun;

const neverRuns: GateScriptExecutor = async () => {
  throw new Error('runScript should not be called when there are no scripts');
};

describe('evaluateDeliverableContract', () => {
  it('approves an empty contract (nothing to check)', async () => {
    const v = await evaluateDeliverableContract({ contract: {}, ws: ws({}), runScript: neverRuns });
    expect(v.decision).toBe('approve');
  });

  it('approves when in-process checks pass', async () => {
    const v = await evaluateDeliverableContract({
      contract: { checks: [{ kind: 'minBytes', file: 'brief.md', bytes: 5 }] },
      ws: ws({ 'brief.md': 'hello world' }),
      runScript: neverRuns,
    });
    expect(v.decision).toBe('approve');
  });

  it('rejects with a prescriptive message + fingerprint when a check fails', async () => {
    const v = await evaluateDeliverableContract({
      contract: { checks: [{ kind: 'minBytes', file: 'brief.md', bytes: 100 }] },
      ws: ws({ 'brief.md': 'too short' }),
      runScript: neverRuns,
    });
    expect(v.decision).toBe('reject');
    expect(v.message).toContain('brief.md');
    expect(v.fingerprint).toBeTruthy();
  });

  it('surfaces a standard-scope script reject as the verdict', async () => {
    const runScript: GateScriptExecutor = async (ref) =>
      okRun(ref.name, { decision: 'reject', message: 'cite your sources' });
    const v = await evaluateDeliverableContract({
      contract: {
        scripts: [
          { name: 'checkCitationsResolve', scope: 'standard', inputs: { file: 'brief.md' } },
        ],
      },
      ws: ws({ 'brief.md': 'x' }),
      runScript,
    });
    expect(v.decision).toBe('reject');
    expect(v.message).toBe('cite your sources');
    expect(v.fingerprint).toBeTruthy();
  });

  it('approves when the script approves', async () => {
    const runScript: GateScriptExecutor = async (ref) => okRun(ref.name, { decision: 'approve' });
    const v = await evaluateDeliverableContract({
      contract: {
        scripts: [
          { name: 'checkCitationsResolve', scope: 'standard', inputs: { file: 'brief.md' } },
        ],
      },
      ws: ws({ 'brief.md': 'x' }),
      runScript,
    });
    expect(v.decision).toBe('approve');
  });

  it('checks gate before scripts — a failing check short-circuits the script', async () => {
    let scriptRan = false;
    const runScript: GateScriptExecutor = async (ref) => {
      scriptRan = true;
      return okRun(ref.name, { decision: 'approve' });
    };
    const v = await evaluateDeliverableContract({
      contract: {
        checks: [{ kind: 'minBytes', file: 'brief.md', bytes: 100 }],
        scripts: [
          { name: 'checkCitationsResolve', scope: 'standard', inputs: { file: 'brief.md' } },
        ],
      },
      ws: ws({ 'brief.md': 'short' }),
      runScript,
    });
    expect(v.decision).toBe('reject');
    expect(scriptRan).toBe(false);
  });
});
