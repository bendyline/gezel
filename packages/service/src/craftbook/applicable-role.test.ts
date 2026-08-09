import type { CatalogItemSummary } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import { listApplicableCraftbooks, workspaceEntriesLookLikeCodebase } from './applicable.js';

function entry(name: string, directory = false) {
  return { name, isDirectory: () => directory };
}

function book(id: string, role: 'project-starter' | 'maintenance-review' | 'general') {
  return {
    sourceId: 'bundled',
    kind: 'craftbook-template',
    manifest: {
      kind: 'craftbook-template',
      id,
      role,
    },
  } as unknown as CatalogItemSummary;
}

describe('project-aware craftbook roles', () => {
  it('recognizes normal codebase roots without treating a document folder as code', () => {
    expect(workspaceEntriesLookLikeCodebase([entry('.git', true)])).toBe(true);
    expect(workspaceEntriesLookLikeCodebase([entry('package.json')])).toBe(true);
    expect(workspaceEntriesLookLikeCodebase([entry('src', true)])).toBe(true);
    expect(workspaceEntriesLookLikeCodebase([entry('main.py')])).toBe(true);
    expect(workspaceEntriesLookLikeCodebase([entry('README.md'), entry('research', true)])).toBe(
      false,
    );
  });

  it('hides project starters only for established codebases', async () => {
    const items = [
      book('branding-website', 'project-starter'),
      book('code-review', 'maintenance-review'),
      book('research-report', 'general'),
    ];
    const catalog = { list: async () => items };
    const store = { getProject: async () => null } as unknown as Store;

    const established = await listApplicableCraftbooks(catalog as never, store, 'project', {
      establishedCodebase: true,
    });
    expect(established.map((item) => item.manifest.id)).toEqual(['code-review', 'research-report']);

    const blank = await listApplicableCraftbooks(catalog as never, store, 'project', {
      establishedCodebase: false,
    });
    expect(blank.map((item) => item.manifest.id)).toEqual([
      'branding-website',
      'code-review',
      'research-report',
    ]);
  });
});
