import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { HarnessConnectResponse, UnifiedSearchResult } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { HarnessBinding } from './session.js';
import { arrangeSearchResults, harnessSources, isDocPath } from './tools.js';

const folder = resolve(tmpdir(), 'gezel-harness-tools', 'repo');

function binding(info: Partial<HarnessConnectResponse> = {}): HarnessBinding {
  return {
    key: 'k',
    request: { client: 'claude-code' },
    info: {
      token: 'T',
      appId: 'harness:claude-code:repo',
      project: { id: 'repo', name: 'repo', workingDir: folder, readOnly: true, created: false },
      memory: 'save',
      images: 'local',
      ...info,
    },
  };
}

let next = 0;
function hit(overrides: Partial<UnifiedSearchResult>): UnifiedSearchResult {
  next += 1;
  return {
    kind: 'content',
    id: `h${next}`,
    title: 't',
    score: 1,
    retrievalSource: 'workspace',
    ...overrides,
  };
}

describe('isDocPath', () => {
  it('counts prose, manifests, and docs folders as docs', () => {
    for (const path of [
      'README.md',
      'notes.txt',
      'docs/setup.ts',
      'packages/x/docs/a.ts',
      'package.json',
      'LICENSE',
      'src\\Docs\\a.ts',
    ]) {
      expect(isDocPath(path), path).toBe(true);
    }
  });

  it('counts code and tests as code', () => {
    for (const path of ['src/index.ts', 'src/app.test.ts', 'tsconfig.json', 'docsite.ts']) {
      expect(isDocPath(path), path).toBe(false);
    }
  });
});

describe('harnessSources', () => {
  it('searches the folder, the library, and memories by default', () => {
    expect(harnessSources(binding(), undefined)).toEqual([
      'workspace',
      'artifacts',
      'shared',
      'project-memory',
      'user-memory',
    ]);
    expect(harnessSources(binding(), [])).toEqual(harnessSources(binding(), undefined));
  });

  it('asks for knowledge only by name', () => {
    expect(harnessSources(binding(), ['knowledge'])).toEqual(['knowledge']);
  });

  it('drops project corpora for an unbound app and memories when they are off', () => {
    expect(harnessSources(binding({ project: null }), undefined)).toEqual([
      'shared',
      'user-memory',
    ]);
    expect(harnessSources(binding({ memory: 'off' }), undefined)).toEqual([
      'workspace',
      'artifacts',
      'shared',
    ]);
  });
});

describe('arrangeSearchResults', () => {
  const opts = { maxResults: 10, sideByName: false };

  it('lists each file once with every matching range', () => {
    const { folder: lines } = arrangeSearchResults(
      binding(),
      [
        hit({ path: 'src/a.ts', line: 12, lineEnd: 30, snippet: '  export   function a() {}' }),
        hit({ path: 'src/a.ts', line: 88 }),
        hit({ path: 'src/b.ts' }),
      ],
      opts,
    );
    expect(lines).toEqual([
      `- ${join(folder, 'src/a.ts')}:12-30, 88\n  export function a() {}`,
      `- ${join(folder, 'src/b.ts')}`,
    ]);
  });

  it('puts docs after the code, at most three, unless there is no code', () => {
    const docs = ['a.md', 'b.md', 'c.md', 'd.md'].map((path) => hit({ path }));
    const withCode = arrangeSearchResults(binding(), [...docs, hit({ path: 'src/a.ts' })], opts);
    expect(withCode.folder).toHaveLength(1);
    expect(withCode.docs).toHaveLength(3);

    const onlyDocs = arrangeSearchResults(binding(), docs, opts);
    expect(onlyDocs.folder).toHaveLength(0);
    expect(onlyDocs.docs).toHaveLength(4);
  });

  it('keeps only strong side hits beside folder results, unless they were asked for', () => {
    const results = [
      hit({ path: 'src/a.ts' }),
      hit({ kind: 'memory', retrievalSource: 'user-memory', snippet: 'weak', tier: 'weak' }),
      hit({
        kind: 'memory',
        retrievalSource: 'user-memory',
        snippet: 'prefers tabs',
        tier: 'strong',
        memory: { day: '2026-10-01', kind: 'pref' },
      }),
    ];
    expect(arrangeSearchResults(binding(), results, opts).side).toEqual([
      '- memory (2026-10-01, pref): prefers tabs',
    ]);
    expect(
      arrangeSearchResults(binding(), results, { ...opts, sideByName: true }).side,
    ).toHaveLength(2);
  });

  it('hides the Handboek and drops media beside readable files', () => {
    const { folder: lines, side } = arrangeSearchResults(
      binding(),
      [
        hit({ path: 'src/a.ts' }),
        hit({ path: 'shots/a.png', media: { modality: 'image', assetPath: 'shots/a.png' } }),
        hit({
          kind: 'knowledge',
          retrievalSource: 'knowledge',
          catalogId: 'handboek',
          tier: 'strong',
        }),
      ],
      opts,
    );
    expect(lines).toEqual([`- ${join(folder, 'src/a.ts')}`]);
    expect(side).toEqual([]);
  });

  it('keeps media when it is all the folder has', () => {
    const { folder: lines } = arrangeSearchResults(
      binding(),
      [hit({ path: 'shots/a.png', media: { modality: 'image', assetPath: 'shots/a.png' } })],
      opts,
    );
    expect(lines).toHaveLength(1);
  });

  it('shows at most two area overviews', () => {
    const overviews = ['src', 'docs-site', 'scripts'].map((area) =>
      hit({ id: `overview:repo:${area}`, projectId: 'repo', snippet: `About ${area}` }),
    );
    const { folder: lines } = arrangeSearchResults(binding(), overviews, opts);
    expect(lines).toEqual([
      `- Overview of ${join(folder, 'src')}${sep} (Gezel's summary)\n  About src`,
      `- Overview of ${join(folder, 'docs-site')}${sep} (Gezel's summary)\n  About docs-site`,
    ]);
  });
});
