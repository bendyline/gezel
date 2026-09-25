import { describe, expect, it } from 'vitest';
import { gateDampingHash, gateDampingInputs } from './gate-damping.js';

const scopeGate = {
  checks: [
    { kind: 'minBytes', file: 'tasks/1/scope.md', artifact: true },
    { kind: 'sniff', file: 'tasks/1/scope.md', artifact: true },
    { kind: 'sniff', file: 'tasks/1/billables.json', artifact: true },
  ],
  scripts: [],
};
const scopeStep = { advanceWhen: { file: 'tasks/1/billables.json', artifact: true } };
const reader = (files: Record<string, string>) => async (file: string) => files[file] ?? null;
const billables = '[{"client":"Harbor & Pine Architects"}]';

describe('gateDampingInputs', () => {
  it('lists the checkpoint and every checked file once, checkpoint first', () => {
    expect(gateDampingInputs(scopeGate, scopeStep)).toEqual([
      { file: 'tasks/1/billables.json', artifact: true },
      { file: 'tasks/1/scope.md', artifact: true },
    ]);
  });

  it('never damps a scripted gate', () => {
    expect(
      gateDampingInputs({ ...scopeGate, scripts: [{ name: 'checkTaskNoteContains' }] }, scopeStep),
    ).toBeNull();
  });

  it('never damps a check whose verdict reads beyond one file', () => {
    for (const kind of ['commandEvidence', 'fileCount', 'valuesSubsetOf', 'judge']) {
      const gate = { checks: [{ kind, file: 'report.md' }], scripts: [] };
      expect(gateDampingInputs(gate, scopeStep)).toBeNull();
    }
  });

  it('returns null with nothing to hash', () => {
    expect(gateDampingInputs({ checks: [], scripts: [] }, {})).toBeNull();
  });
});

describe('gateDampingHash', () => {
  it('changes when a checked file appears although the checkpoint is unchanged', async () => {
    const before = await gateDampingHash(
      scopeGate,
      scopeStep,
      reader({ 'tasks/1/billables.json': billables }),
    );
    const after = await gateDampingHash(
      scopeGate,
      scopeStep,
      reader({
        'tasks/1/billables.json': billables,
        'tasks/1/scope.md': '# Scope\n\n## Skipped clients\nnone\n',
      }),
    );
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });

  it('is stable for identical bytes', async () => {
    const files = { 'tasks/1/billables.json': billables, 'tasks/1/scope.md': '# Scope' };
    expect(await gateDampingHash(scopeGate, scopeStep, reader(files))).toBe(
      await gateDampingHash(scopeGate, scopeStep, reader({ ...files })),
    );
  });

  it('tells an empty file from a missing one', async () => {
    const missing = await gateDampingHash(
      scopeGate,
      scopeStep,
      reader({ 'tasks/1/billables.json': billables }),
    );
    const empty = await gateDampingHash(
      scopeGate,
      scopeStep,
      reader({ 'tasks/1/billables.json': billables, 'tasks/1/scope.md': '' }),
    );
    expect(empty).not.toBe(missing);
  });

  it('is undefined when no input exists yet', async () => {
    expect(await gateDampingHash(scopeGate, scopeStep, reader({}))).toBeUndefined();
  });
});
