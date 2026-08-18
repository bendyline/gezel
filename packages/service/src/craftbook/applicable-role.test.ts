import type { CatalogItemSummary } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import {
  craftbookContextForProject,
  listApplicableCraftbooks,
  workspaceEntriesLookLikeCodebase,
} from './applicable.js';

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

function connectorBook(id: string, optional = false): CatalogItemSummary {
  return {
    sourceId: 'bundled',
    kind: 'craftbook-template',
    manifest: {
      kind: 'craftbook-template',
      id,
      role: 'general',
      connectors: [{ typeId: 'github-pulls', ...(optional ? { optional: true } : {}) }],
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

  it('hides connector-reading craftbooks only when the posture forbids corpus movement', async () => {
    // Super-lockdown refuses connector prep, so the card would be a button
    // that always fails. An `optional` corpus degrades instead, so a book
    // that merely prefers one stays offered.
    const items = [
      book('research-report', 'general'),
      connectorBook('pull-request-review'),
      connectorBook('inbox-digest', true),
    ];
    const catalog = { list: async () => items };
    const store = { getProject: async () => null } as unknown as Store;

    const blocked = await listApplicableCraftbooks(catalog as never, store, 'project', {
      establishedCodebase: false,
      connectorDataAllowed: false,
    });
    expect(blocked.map((item) => item.manifest.id)).toEqual(['research-report', 'inbox-digest']);

    const allowed = await listApplicableCraftbooks(catalog as never, store, 'project', {
      establishedCodebase: false,
      connectorDataAllowed: true,
    });
    expect(allowed.map((item) => item.manifest.id)).toEqual([
      'research-report',
      'pull-request-review',
      'inbox-digest',
    ]);
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

  it('uses the checkout HEAD instead of stale stored branch metadata', async () => {
    const store = {
      getProject: async () => ({
        id: 'project',
        name: 'Project',
        github: {
          url: 'https://github.com/bendyline/gezel',
          branch: 'main',
        },
      }),
    } as unknown as Store;
    const git = { status: async () => ({ branch: 'bendymike-uxfixes8.9' }) };

    await expect(craftbookContextForProject(store, 'project', git)).resolves.toEqual({
      hasGitHub: true,
      branch: 'bendymike-uxfixes8.9',
    });
  });

  it('offers branch-gated craftbooks when the live checkout is on a feature branch', async () => {
    const pullRequestReview = book('pull-request-review', 'maintenance-review');
    if (pullRequestReview.manifest.kind !== 'craftbook-template') {
      throw new Error('expected craftbook template');
    }
    pullRequestReview.manifest.requirements = [{ kind: 'github' }, { kind: 'non-main-branch' }];
    const catalog = { list: async () => [pullRequestReview] };
    const store = {
      getProject: async () => ({
        id: 'project',
        name: 'Project',
        github: {
          url: 'https://github.com/bendyline/gezel',
          branch: 'main',
        },
      }),
    } as unknown as Store;
    const git = { status: async () => ({ branch: 'bendymike-uxfixes8.9' }) };

    const items = await listApplicableCraftbooks(catalog as never, store, 'project', {
      establishedCodebase: true,
      git,
    });

    expect(items.map((item) => item.manifest.id)).toEqual(['pull-request-review']);
  });

  it('falls back to stored branch metadata when live git status fails', async () => {
    const store = {
      getProject: async () => ({
        id: 'project',
        name: 'Project',
        github: {
          url: 'https://github.com/bendyline/gezel',
          branch: 'feature/stored',
        },
      }),
    } as unknown as Store;
    const git = {
      status: async (): Promise<{ branch?: string }> => {
        throw new Error('git unavailable');
      },
    };

    await expect(craftbookContextForProject(store, 'project', git)).resolves.toEqual({
      hasGitHub: true,
      branch: 'feature/stored',
    });
  });

  it('does not revive a stale stored branch when live HEAD is detached', async () => {
    const store = {
      getProject: async () => ({
        id: 'project',
        name: 'Project',
        github: {
          url: 'https://github.com/bendyline/gezel',
          branch: 'feature/stale',
        },
      }),
    } as unknown as Store;
    const git = { status: async () => ({}) };

    await expect(craftbookContextForProject(store, 'project', git)).resolves.toEqual({
      hasGitHub: true,
      branch: null,
    });
  });
});
