import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogItemSummary } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import { bootstrapWorkspace } from '../workspace/template.js';
import {
  craftbookContextForProject,
  listApplicableCraftbooks,
  projectHasEstablishedCodebase,
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

describe('fresh internal workspaces', () => {
  let dir: string;
  let project: { id: string; name: string; workingDir?: string; github?: { url: string } };
  let store: Store;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-craftbook-fresh-'));
    project = { id: 'project', name: 'Renamed project' };
    store = {
      projectWorkspaceDir: async () => dir,
      getProject: async () => project,
      readConfig: async () => ({}),
    } as unknown as Store;
    await bootstrapWorkspace({
      workspaceDir: dir,
      projectId: 'project',
      projectName: 'Original name',
    });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('offers project starters when only unchanged bootstrap files exist', async () => {
    const catalog = {
      list: async () => [book('new-site', 'project-starter'), book('research', 'general')],
    };
    expect(await projectHasEstablishedCodebase(store, project.id)).toBe(false);
    const items = await listApplicableCraftbooks(catalog as never, store, project.id);
    expect(items.map((item) => item.manifest.id)).toEqual(['new-site', 'research']);
  });

  it.each(['workingDir', 'github'] as const)(
    'does not exempt bootstrap-shaped files in an external %s project',
    async (kind) => {
      if (kind === 'workingDir') project.workingDir = dir;
      else project.github = { url: 'https://example.com/repository' };
      expect(await projectHasEstablishedCodebase(store, project.id)).toBe(true);
    },
  );

  it.each(['package.json', 'tsconfig.json'])(
    'recognizes customized %s as existing work',
    async (name) => {
      const data = JSON.parse(await readFile(join(dir, name), 'utf8'));
      if (name === 'package.json') data.scripts = { test: 'node --test' };
      else data.compilerOptions.target = 'esnext';
      await writeFile(join(dir, name), JSON.stringify(data));
      expect(await projectHasEstablishedCodebase(store, project.id)).toBe(true);
      const items = await listApplicableCraftbooks(
        { list: async () => [book('new-site', 'project-starter')] } as never,
        store,
        project.id,
      );
      expect(items).toEqual([]);
    },
  );

  it.each(['index.html', 'nested/main.py', 'nested/package.json', '.git/config'])(
    'keeps recognizing real work at %s alongside bootstrap files',
    async (path) => {
      const parts = path.split('/');
      if (parts.length > 1) await mkdir(join(dir, parts[0]!), { recursive: true });
      await writeFile(join(dir, path), 'real project content');
      expect(await projectHasEstablishedCodebase(store, project.id)).toBe(true);
    },
  );

  it('does not treat an unreadable or malformed package file as untouched scaffolding', async () => {
    await writeFile(join(dir, 'package.json'), '{');
    expect(await projectHasEstablishedCodebase(store, project.id)).toBe(true);
  });
});
