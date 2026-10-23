import type { CodebaseMapResponse } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { CODEBASE_MAP_PATH, type CodebaseMapDeps, writeCodebaseMap } from './codebase-map.js';

const MAP: CodebaseMapResponse = {
  indexed: true,
  architecture: 'A spreadsheet engine and its editor.',
  areas: [
    { path: 'src', depth: 0, purpose: 'Holds the product code.', keyFiles: [] },
    {
      path: 'src/calc',
      depth: 1,
      purpose: 'Evaluates spreadsheet formulas.',
      keyFiles: [{ path: 'src/calc/engine.ts', purpose: 'Recalculates dirty cells.' }],
    },
  ],
  loadBearing: [{ path: 'src/calc/types.ts', importers: 12, purpose: 'Defines cell types.' }],
};

function harness(opts: { kind?: string; map?: CodebaseMapResponse; pkg?: string } = {}) {
  const writes: Array<{ path: string; content: string }> = [];
  const artifacts = new Map<string, string>();
  const deps: CodebaseMapDeps = {
    store: {
      getProject: async () => ({
        id: 'p1',
        name: 'calc',
        properties: { 'gezel.folderKind': opts.kind ?? 'code' },
      }),
      readProjectArtifact: async (_id, path) => artifacts.get(path) ?? null,
      writeProjectArtifact: async (_id, path, content) => {
        artifacts.set(path, content);
        writes.push({ path, content });
      },
      readProjectWorkspaceFile: async () =>
        opts.pkg ?? JSON.stringify({ scripts: { test: 'vitest run', dev: 'vite' } }),
    },
    contentIndex: { codebaseMap: async () => opts.map ?? MAP },
  };
  return { deps, writes };
}

describe('codebase map', () => {
  it('writes folder purposes, load-bearing files and the test command', async () => {
    const { deps, writes } = harness();
    const path = await writeCodebaseMap(deps, 'p1', new Date('2026-10-21T12:00:00Z'));
    expect(path).toBe(CODEBASE_MAP_PATH);
    const text = writes[0]!.content;
    expect(text).toContain('# calc: codebase map');
    expect(text).toContain('on 2026-10-21.');
    expect(text).toContain('A spreadsheet engine and its editor.');
    expect(text).toContain('- `src/`: Holds the product code.');
    expect(text).toContain('  - `src/calc/`: Evaluates spreadsheet formulas.');
    expect(text).toContain('- `src/calc/types.ts` (imported by 12): Defines cell types.');
    expect(text).toContain('- `npm run test`: `vitest run`');
    expect(text).not.toContain('npm run dev');
  });

  it('leaves the file alone when only the date would change', async () => {
    const { deps, writes } = harness();
    await writeCodebaseMap(deps, 'p1', new Date('2026-10-21T12:00:00Z'));
    expect(await writeCodebaseMap(deps, 'p1', new Date('2026-10-22T12:00:00Z'))).toBeNull();
    expect(writes).toHaveLength(1);
  });

  it('writes nothing for a folder that is not code, or before the index has areas', async () => {
    expect(await writeCodebaseMap(harness({ kind: 'photos' }).deps, 'p1', new Date())).toBeNull();
    const empty = harness({ map: { indexed: false, areas: [], loadBearing: [] } });
    expect(await writeCodebaseMap(empty.deps, 'p1', new Date())).toBeNull();
    expect(empty.writes).toHaveLength(0);
  });
});
