import { describe, expect, it } from 'vitest';
import type { GateCheck } from '../schemas/gate.js';
import {
  type GateWorkspaceReader,
  evaluateDeclarativeCheck,
  gateCheckLabel,
  isSharedGateCheck,
} from './gate-checks.js';

function reader(
  files: Record<string, string>,
  artifacts: Record<string, string> = {},
): GateWorkspaceReader {
  return {
    read: async (file) => files[file] ?? null,
    list: async () => Object.keys(files),
    readArtifact: async (file) => artifacts[file] ?? null,
    listArtifacts: async () => Object.keys(artifacts),
  };
}

const ws = reader(
  {
    'index.html':
      '<!doctype html><html><head><style>body{margin:0}</style></head><body><script>console.log(1)</script></body></html>',
    'data.csv': 'name,age\nAda,36\nBob,41\n',
    'config.json': '{"mode":"prod","items":[1,2]}',
    'notes.md': 'Some notes\n',
    'a.png': 'x',
  },
  { 'report.md': '# Report\n\nA real report with content.\n' },
);

describe('evaluateDeclarativeCheck', () => {
  it.each<[GateCheck, boolean]>([
    [{ kind: 'minBytes', file: 'notes.md', bytes: 5 }, true],
    [{ kind: 'minBytes', file: 'missing.md', bytes: 1 }, false],
    [{ kind: 'totalMinBytes', files: ['notes.md', 'data.csv'], bytes: 10 }, true],
    [{ kind: 'fileCount', ext: ['png'], min: 1 }, true],
    [{ kind: 'fileCount', ext: ['jpg'], min: 1 }, false],
    [{ kind: 'cssMinBytes', bytes: 5, file: 'index.html' }, true],
    [{ kind: 'sniff', file: 'notes.md', sniff: 'nonempty' }, true],
    [{ kind: 'sniff', file: 'config.json', sniff: 'json-valid' }, true],
    [{ kind: 'jsonPathEquals', file: 'config.json', path: 'mode', value: 'prod' }, true],
    [{ kind: 'jsonPathEquals', file: 'config.json', path: 'mode', value: 'dev' }, false],
    [{ kind: 'csvShape', file: 'data.csv', requiredColumns: ['name', 'age'], minRows: 2 }, true],
    [{ kind: 'csvShape', file: 'data.csv', requiredColumns: ['name', 'city'] }, false],
  ])('%j -> %s', async (check, ok) => {
    const outcome = await evaluateDeclarativeCheck(check as never, ws);
    expect(outcome.ok).toBe(ok);
    expect(outcome.detail.length).toBeGreaterThan(0);
  });

  it('reads the artifacts drawer when a check is flagged, and fails closed without one', async () => {
    const flagged = {
      kind: 'minBytes',
      file: 'report.md',
      bytes: 5,
      artifact: true,
    } as GateCheck as never;
    expect((await evaluateDeclarativeCheck(flagged, ws)).ok).toBe(true);
    const plain: GateWorkspaceReader = { read: async () => 'x', list: async () => [] };
    // Without a drawer the flagged file is unreadable, so the check cannot pass.
    expect((await evaluateDeclarativeCheck(flagged, plain)).ok).toBe(false);
  });

  it('names the gap when a sniff fails and the file when one is missing', async () => {
    const failed = await evaluateDeclarativeCheck(
      { kind: 'sniff', file: 'notes.md', sniff: 'json-valid' } as never,
      ws,
    );
    expect(failed.ok).toBe(false);
    expect(failed.detail).toMatch(/^notes\.md failed the json-valid check: /);
    const missing = await evaluateDeclarativeCheck(
      { kind: 'sniff', file: 'nope.md', sniff: 'nonempty' } as never,
      ws,
    );
    expect(missing.detail).toBe('nope.md not found (needed for the nonempty check)');
  });

  it('labels a check by its configuration, never its observed values', () => {
    expect(gateCheckLabel({ kind: 'minBytes', file: 'a.md', bytes: 9 } as GateCheck)).toBe(
      'minBytes a.md',
    );
    expect(gateCheckLabel({ kind: 'sniff', file: 'a.md', sniff: 'nonempty' } as GateCheck)).toBe(
      'sniff a.md nonempty',
    );
    expect(isSharedGateCheck({ kind: 'contains', file: 'a', pattern: 'x' } as GateCheck)).toBe(
      false,
    );
  });
});
