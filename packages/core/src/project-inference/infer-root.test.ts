import { describe, expect, it } from 'vitest';
import { inferProjectRoot } from './infer-root.js';
import { memoryFsProbe } from './memory-probe.js';
import type { ExistingProjectRef, ForbiddenContext, InferencePlatform } from './types.js';
import { wellKnownFolders } from './well-known-folders.js';

function macCtx(): ForbiddenContext {
  return {
    platform: 'darwin',
    homedir: '/Users/me',
    env: {},
    tmpdir: '/private/tmp',
    gezelHome: '/Users/me/.gezel',
  };
}

function setup(
  platform: InferencePlatform,
  ctx: ForbiddenContext,
  files: string[],
  existing: ExistingProjectRef[] = [],
  opts: { unreadable?: string[]; cloudStorageEntries?: string[] } = {},
) {
  const fs = memoryFsProbe(files, platform, { unreadable: opts.unreadable });
  const wellKnown = wellKnownFolders({ ...ctx, cloudStorageEntries: opts.cloudStorageEntries });
  return {
    infer: (path: string, kind: 'document' | 'folder' = 'document', policy = {}) =>
      inferProjectRoot({ path, kind, ctx, wellKnown, existing, policy }, fs),
  };
}

const ENGINEERING_TREE = [
  '/Users/me/work/engineeringdocs/alpha/report.docx',
  '/Users/me/work/engineeringdocs/alpha/notes.md',
  '/Users/me/work/engineeringdocs/bravo/spec.docx',
  '/Users/me/work/engineeringdocs/overview.pdf',
];

describe('climb outside well-known roots', () => {
  it('resolves alpha/ to its sibling-grouping parent engineeringdocs', async () => {
    const { infer } = setup('darwin', macCtx(), ENGINEERING_TREE);
    const out = await infer('/Users/me/work/engineeringdocs/alpha/report.docx');
    expect(out.matchedBy).toBe('climb');
    expect(out.root).toBe('/Users/me/work/engineeringdocs');
    if (out.matchedBy === 'climb') expect(out.score.shape).toBe(2);
  });

  it('stops at a strong marker: a .git in alpha makes alpha the project', async () => {
    const { infer } = setup('darwin', macCtx(), [
      ...ENGINEERING_TREE,
      '/Users/me/work/engineeringdocs/alpha/.git/',
    ]);
    const out = await infer('/Users/me/work/engineeringdocs/alpha/report.docx');
    expect(out).toMatchObject({ matchedBy: 'climb', root: '/Users/me/work/engineeringdocs/alpha' });
  });

  it('a strong marker several levels up wins over the sibling shape', async () => {
    const { infer } = setup('darwin', macCtx(), [
      '/Users/me/code/repo/.git/',
      '/Users/me/code/repo/docs/specs/alpha/a.docx',
      '/Users/me/code/repo/docs/specs/bravo/b.docx',
    ]);
    const out = await infer('/Users/me/code/repo/docs/specs/alpha/a.docx');
    expect(out.root).toBe('/Users/me/code/repo');
  });

  it('falls back to the document folder when there is only one sibling', async () => {
    const { infer } = setup('darwin', macCtx(), ['/Users/me/work/solo/alpha/report.docx']);
    const out = await infer('/Users/me/work/solo/alpha/report.docx');
    expect(out).toMatchObject({
      matchedBy: 'parent',
      root: '/Users/me/work/solo/alpha',
      name: 'alpha',
    });
  });

  it('penalises container folders like ~/work', async () => {
    const { infer } = setup('darwin', macCtx(), [
      '/Users/me/work/a/x.docx',
      '/Users/me/work/b/y.docx',
    ]);
    const out = await infer('/Users/me/work/a/x.docx');
    expect(out).toMatchObject({ matchedBy: 'parent', root: '/Users/me/work/a' });
  });

  it('never climbs into a folder that contains another project', async () => {
    const existing: ExistingProjectRef[] = [
      { id: 'repo-a', workingDir: '/Users/me/stuff/repoA', name: 'repoA', sharedLibrary: false },
    ];
    const { infer } = setup(
      'darwin',
      macCtx(),
      [
        '/Users/me/stuff/notes/x.docx',
        '/Users/me/stuff/other/y.docx',
        '/Users/me/stuff/repoA/z.docx',
      ],
      existing,
    );
    const out = await infer('/Users/me/stuff/notes/x.docx');
    expect(out).toMatchObject({ matchedBy: 'parent', root: '/Users/me/stuff/notes' });
  });

  it('stops at an unreadable or oversized folder', async () => {
    const { infer } = setup('darwin', macCtx(), ENGINEERING_TREE, [], {
      unreadable: ['/Users/me/work/engineeringdocs'],
    });
    const out = await infer('/Users/me/work/engineeringdocs/alpha/report.docx');
    expect(out).toMatchObject({
      matchedBy: 'parent',
      root: '/Users/me/work/engineeringdocs/alpha',
    });
  });

  it('never proposes a mount point: /Volumes/USB/engineeringdocs is the ceiling', async () => {
    const { infer } = setup('darwin', macCtx(), [
      '/Volumes/USB/engineeringdocs/alpha/a.docx',
      '/Volumes/USB/engineeringdocs/bravo/b.docx',
    ]);
    const out = await infer('/Volumes/USB/engineeringdocs/alpha/a.docx');
    expect(out.root).toBe('/Volumes/USB/engineeringdocs');
  });
});

describe('well-known roots', () => {
  it('a loose document in Documents maps to the Documents folder', async () => {
    const { infer } = setup('darwin', macCtx(), ['/Users/me/Documents/budget.xlsx']);
    const out = await infer('/Users/me/Documents/budget.xlsx');
    expect(out).toMatchObject({
      matchedBy: 'well-known',
      root: '/Users/me/Documents',
      name: 'Documents',
    });
  });

  it('a lone subfolder of Documents maps to Documents, not the subfolder', async () => {
    const { infer } = setup('darwin', macCtx(), ['/Users/me/Documents/Taxes/return.pdf']);
    const out = await infer('/Users/me/Documents/Taxes/return.pdf');
    expect(out.matchedBy).toBe('well-known');
    expect(out.root).toBe('/Users/me/Documents');
  });

  it('finds engineeringdocs inside Documents with the default (full) policy', async () => {
    const { infer } = setup('darwin', macCtx(), [
      '/Users/me/Documents/engineeringdocs/alpha/report.docx',
      '/Users/me/Documents/engineeringdocs/bravo/spec.docx',
    ]);
    const out = await infer('/Users/me/Documents/engineeringdocs/alpha/report.docx');
    expect(out).toMatchObject({ matchedBy: 'climb', root: '/Users/me/Documents/engineeringdocs' });
    if (out.matchedBy === 'climb') expect(out.folder?.kind).toBe('documents');
  });

  it('markers-only policy keeps Documents unless a strong marker is present', async () => {
    const files = [
      '/Users/me/Documents/engineeringdocs/alpha/report.docx',
      '/Users/me/Documents/engineeringdocs/bravo/spec.docx',
    ];
    const plain = setup('darwin', macCtx(), files);
    expect(
      (await plain.infer(files[0]!, 'document', { climbInsideWellKnown: 'markers-only' })).root,
    ).toBe('/Users/me/Documents');
    const marked = setup('darwin', macCtx(), [
      ...files,
      '/Users/me/Documents/engineeringdocs/.git/',
    ]);
    expect(
      (await marked.infer(files[0]!, 'document', { climbInsideWellKnown: 'markers-only' })).root,
    ).toBe('/Users/me/Documents/engineeringdocs');
  });

  it('never climbs above the well-known root', async () => {
    const { infer } = setup('darwin', macCtx(), [
      '/Users/me/Documents/alpha/a.docx',
      '/Users/me/Documents/bravo/b.docx',
    ]);
    // Documents itself has the sibling shape, but it is the ceiling, so the
    // result is the well-known root (named "Documents"), not a climb.
    const out = await infer('/Users/me/Documents/alpha/a.docx');
    expect(out).toMatchObject({ matchedBy: 'well-known', root: '/Users/me/Documents' });
  });

  it('maps a OneDrive Known Folder Move document to the redirected Documents', async () => {
    const ctx: ForbiddenContext = {
      platform: 'win32',
      homedir: 'C:\\Users\\me',
      env: { OneDrive: 'C:\\Users\\me\\OneDrive' },
      tmpdir: 'C:\\Users\\me\\AppData\\Local\\Temp',
      gezelHome: 'C:\\Users\\me\\.gezel',
    };
    const { infer } = setup('win32', ctx, ['C:\\Users\\me\\OneDrive\\Documents\\plan.docx']);
    const out = await infer('C:\\Users\\me\\OneDrive\\Documents\\plan.docx');
    expect(out.matchedBy).toBe('well-known');
    if (out.matchedBy === 'well-known') {
      expect(out.folder.cloud).toBe('onedrive');
      expect(out.folder.kind).toBe('documents');
    }
  });

  it('a macOS CloudStorage root is a well-known root; its parent is not', async () => {
    const { infer } = setup(
      'darwin',
      macCtx(),
      ['/Users/me/Library/CloudStorage/Dropbox/x.docx', '/Users/me/Library/CloudStorage/y.docx'],
      [],
      { cloudStorageEntries: ['Dropbox'] },
    );
    expect(await infer('/Users/me/Library/CloudStorage/Dropbox/x.docx')).toMatchObject({
      matchedBy: 'well-known',
      root: '/Users/me/Library/CloudStorage/Dropbox',
    });
    expect(await infer('/Users/me/Library/CloudStorage/y.docx')).toMatchObject({
      matchedBy: 'default',
      reason: 'cloud-root-parent',
    });
  });
});

describe('existing projects', () => {
  const existing: ExistingProjectRef[] = [
    { id: 'docs', workingDir: '/Users/me/Documents', name: 'Documents', sharedLibrary: false },
    {
      id: 'thesis',
      workingDir: '/Users/me/Documents/thesis',
      name: 'Thesis',
      sharedLibrary: false,
    },
    {
      id: 'shared',
      workingDir: '/Users/me/Library-ish/GezelDocs',
      name: 'Library',
      sharedLibrary: true,
    },
  ];

  it('the deepest containing project wins', async () => {
    const { infer } = setup('darwin', macCtx(), [], existing);
    expect(await infer('/Users/me/Documents/thesis/ch1.docx')).toMatchObject({
      matchedBy: 'existing',
      projectId: 'thesis',
    });
    expect(await infer('/users/me/documents/budget.xlsx')).toMatchObject({
      matchedBy: 'existing',
      projectId: 'docs',
    });
  });

  it('reports the shared library as an existing project', async () => {
    const { infer } = setup('darwin', macCtx(), [], existing);
    expect(await infer('/Users/me/Library-ish/GezelDocs/policy.docx')).toMatchObject({
      matchedBy: 'existing',
      projectId: 'shared',
      sharedLibrary: true,
    });
  });

  it('keeps an existing project at a forbidden root, with a warning', async () => {
    const odd: ExistingProjectRef[] = [
      { id: 'home', workingDir: '/Users/me', name: 'Home', sharedLibrary: false },
    ];
    const { infer } = setup('darwin', macCtx(), [], odd);
    expect(await infer('/Users/me/report.docx')).toMatchObject({
      matchedBy: 'existing',
      projectId: 'home',
      warnings: ['existing-project-at-forbidden-root'],
    });
  });
});

describe('folders (VS Code / CLI)', () => {
  it('returns the folder itself and only matches an exact existing project', async () => {
    const existing: ExistingProjectRef[] = [
      { id: 'repo', workingDir: '/Users/me/code/repo', name: 'repo', sharedLibrary: false },
    ];
    const { infer } = setup('darwin', macCtx(), [], existing);
    expect(await infer('/Users/me/code/repo', 'folder')).toMatchObject({
      matchedBy: 'existing',
      projectId: 'repo',
    });
    expect(await infer('/Users/me/code/repo/packages/a', 'folder')).toMatchObject({
      matchedBy: 'parent',
      root: '/Users/me/code/repo/packages/a',
    });
  });

  it('refuses forbidden folders', async () => {
    const { infer } = setup('darwin', macCtx(), []);
    expect(await infer('/Users/me', 'folder')).toMatchObject({
      matchedBy: 'default',
      reason: 'user-home',
    });
    expect(await infer('/', 'folder')).toMatchObject({
      matchedBy: 'default',
      reason: 'filesystem-root',
    });
  });

  it('accepts a chosen folder where a document would never make a project', async () => {
    const { infer } = setup('darwin', macCtx(), ['/private/tmp/scratch/draft.docx']);
    expect(await infer('/private/tmp/scratch', 'folder')).toMatchObject({
      matchedBy: 'parent',
      root: '/private/tmp/scratch',
    });
    expect(await infer('/private/tmp/scratch/draft.docx')).toMatchObject({
      matchedBy: 'default',
      reason: 'temp-dir',
    });
    expect(await infer('/private/tmp', 'folder')).toMatchObject({
      matchedBy: 'default',
      reason: 'temp-dir',
    });
  });

  it('recognises a well-known folder picked directly', async () => {
    const { infer } = setup('darwin', macCtx(), []);
    expect(await infer('/Users/me/Pictures', 'folder')).toMatchObject({
      matchedBy: 'well-known',
      name: 'Pictures',
    });
  });
});

describe('default project fallbacks', () => {
  it.each([
    ['darwin', '/Users/me/report.docx', 'user-home'],
    ['darwin', '/private/tmp/x.docx', 'temp-dir'],
  ] as const)('%s %s → default (%s)', async (platform, path, reason) => {
    const { infer } = setup(platform, macCtx(), []);
    expect(await infer(path)).toMatchObject({ matchedBy: 'default', reason });
  });

  it('win32 drive roots and network shares fall back, deeper shares do not', async () => {
    const ctx: ForbiddenContext = {
      platform: 'win32',
      homedir: 'C:\\Users\\me',
      env: {},
      tmpdir: 'C:\\Users\\me\\AppData\\Local\\Temp',
      gezelHome: 'C:\\Users\\me\\.gezel',
    };
    const { infer } = setup('win32', ctx, ['\\\\srv\\share\\team\\x.docx']);
    expect(await infer('C:\\x.docx')).toMatchObject({
      matchedBy: 'default',
      reason: 'filesystem-root',
    });
    expect(await infer('\\\\srv\\share\\x.docx')).toMatchObject({
      matchedBy: 'default',
      reason: 'network-root',
    });
    expect(await infer('\\\\srv\\share\\team\\x.docx')).toMatchObject({
      matchedBy: 'parent',
      root: '\\\\srv\\share\\team',
    });
  });

  it('linux: a document in /opt itself falls back, /opt/work does not', async () => {
    const ctx: ForbiddenContext = {
      platform: 'linux',
      homedir: '/home/me',
      env: {},
      tmpdir: '/tmp',
      gezelHome: '/home/me/.gezel',
    };
    const { infer } = setup('linux', ctx, ['/opt/work/a.docx']);
    expect(await infer('/opt/x.docx')).toMatchObject({
      matchedBy: 'default',
      reason: 'system-dir',
    });
    expect(await infer('/opt/work/a.docx')).toMatchObject({
      matchedBy: 'parent',
      root: '/opt/work',
    });
  });
});
