import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import {
  MAX_STAT_TOKENS_PER_TEXT,
  artifactPathsOf,
  buildFileInventoryIndex,
  createFileStatResolver,
  createWorkspaceFileProbe,
  extractReferencedFiles,
  matchReferencedFilesInContent,
  matchReferencedFilesWithIndex,
  scanPathTokens,
  unresolvedQualifiedPaths,
} from './file-references.js';

const artifact = (path: string) => ({ kind: 'artifact' as const, path });
const workspace = (path: string) => ({ kind: 'workspace' as const, path });

describe('scanPathTokens', () => {
  it('strips a trailing line locator', () => {
    expect(scanPathTokens('`useFrameCapture.ts:1633` forwards').map((t) => t.path)).toContain(
      'useFrameCapture.ts',
    );
  });

  it('strips a multi-line locator', () => {
    expect(scanPathTokens('image.ts:84,230 and other.ts:12:5').map((t) => t.path)).toEqual(
      expect.arrayContaining(['image.ts', 'other.ts']),
    );
  });

  it('strips a github-style #L anchor', () => {
    expect(scanPathTokens('see file.ts#L42-L51 there').map((t) => t.path)).toContain('file.ts');
  });

  it('leaves a path with no locator alone', () => {
    expect(scanPathTokens('`docs/API.md`').map((t) => t.path)).toContain('docs/API.md');
  });

  it('drops url spans entirely', () => {
    const paths = scanPathTokens(
      'https://github.com/bendyline/gezel/blob/main/docs/API.md is remote',
    ).map((t) => t.path);
    expect(paths).not.toContain('docs/API.md');
    expect(paths).not.toContain('github.com');
  });
});

describe('matchReferencedFilesInContent', () => {
  it('resolves code-span basenames against the artifact list', () => {
    expect(
      matchReferencedFilesInContent('We built `index.html`, `catalog.html`, `about.html`.', {
        artifacts: ['index.html', 'catalog.html', 'about.html', 'styles/main.css'],
      }),
    ).toEqual([artifact('about.html'), artifact('catalog.html'), artifact('index.html')]);
  });

  it('resolves exact relative paths', () => {
    expect(
      matchReferencedFilesInContent('Update `styles/main.css` to match.', {
        artifacts: ['index.html', 'styles/main.css'],
      }),
    ).toEqual([artifact('styles/main.css')]);
  });

  it('never falls a qualified missing path back to a same-basename root file', () => {
    expect(
      matchReferencedFilesInContent('Requested `powerpoint/task-11/deck.pptx`.', {
        artifacts: ['deck.pptx'],
      }),
    ).toEqual([]);
  });

  it('resolves a qualified nested path exactly when root and nested names collide', () => {
    expect(
      matchReferencedFilesInContent('Wrote `powerpoint/task-11/deck.pptx`.', {
        artifacts: ['deck.pptx', 'powerpoint/task-11/deck.pptx'],
      }),
    ).toEqual([artifact('powerpoint/task-11/deck.pptx')]);
  });

  it('treats a bare root filename as ambiguous when a nested file shares it', () => {
    expect(
      matchReferencedFilesInContent('Open `deck.pptx`.', {
        artifacts: ['deck.pptx', 'powerpoint/task-11/deck.pptx'],
      }),
    ).toEqual([]);
  });

  it('catches bare word-boundary mentions in prose (no backticks)', () => {
    expect(
      matchReferencedFilesInContent(
        'The contact form lives in contact.html — styled by main.css.',
        { artifacts: ['contact.html', 'main.css'] },
      ),
    ).toEqual([artifact('contact.html'), artifact('main.css')]);
  });

  it('drops ambiguous basenames (multiple files share the name)', () => {
    expect(
      matchReferencedFilesInContent('Check `Header.tsx`', {
        artifacts: ['components/Header.tsx', 'routes/Header.tsx'],
      }),
    ).toEqual([]);
  });

  it('drops a basename made ambiguous by a third file', () => {
    expect(
      matchReferencedFilesInContent('Check `index.ts`', {
        workspace: ['a/index.ts', 'b/index.ts', 'c/index.ts'],
      }),
    ).toEqual([]);
  });

  it('skips absolute URLs in markdown link targets', () => {
    expect(
      matchReferencedFilesInContent('See [docs](https://example.com/index.html) and `real.html`', {
        artifacts: ['real.html'],
      }),
    ).toEqual([artifact('real.html')]);
  });

  it('returns [] when nothing matches', () => {
    expect(
      matchReferencedFilesInContent('pure prose with no file references at all.', {
        artifacts: ['index.html'],
      }),
    ).toEqual([]);
  });

  it('dedupes repeated mentions', () => {
    expect(
      matchReferencedFilesInContent('`index.html` then `index.html` then index.html', {
        artifacts: ['index.html'],
      }),
    ).toEqual([artifact('index.html')]);
  });

  it('handles an empty inventory and empty content', () => {
    expect(matchReferencedFilesInContent('see `foo.html`', {})).toEqual([]);
    expect(matchReferencedFilesInContent('', { artifacts: ['foo.html'] })).toEqual([]);
  });

  it('matches filenames inside fenced code blocks', () => {
    expect(
      matchReferencedFilesInContent('```\n<script src="some.js"></script>\n```\nAnd `real.css`', {
        artifacts: ['some.js', 'real.css'],
      }),
    ).toEqual([artifact('real.css'), artifact('some.js')]);
  });

  // The review-prose shapes that motivated the locator handling — every one
  // of these silently resolved to nothing before.
  describe('line-number locators', () => {
    it('resolves a directory-qualified path with a multi-line locator', () => {
      expect(
        matchReferencedFilesInContent(
          '`squisq image` registers a bare `--title` (`packages/cli/src/commands/image.ts:84,230`)',
          { workspace: ['packages/cli/src/commands/image.ts'] },
        ),
      ).toEqual([workspace('packages/cli/src/commands/image.ts')]);
    });

    it('resolves a bare basename with a locator to its nested file', () => {
      expect(
        matchReferencedFilesInContent('`useFrameCapture.ts:1633` forwards layout/title', {
          workspace: ['src/hooks/useFrameCapture.ts'],
        }),
      ).toEqual([workspace('src/hooks/useFrameCapture.ts')]);
    });

    it('does not treat a version-like suffix as a locator on a real path', () => {
      expect(
        matchReferencedFilesInContent('bump `core` to 2.7.1 and read `docs/API.md`', {
          workspace: ['docs/API.md'],
        }),
      ).toEqual([workspace('docs/API.md')]);
    });
  });

  describe('workspace resolution', () => {
    it('finds workspace files, not just artifacts', () => {
      expect(
        matchReferencedFilesInContent('Minors are two `docs/API.md` omissions', {
          artifacts: ['pr-review.md'],
          workspace: ['docs/API.md', 'src/index.ts'],
        }),
      ).toEqual([workspace('docs/API.md')]);
    });

    it('reports both kinds from one reply, artifacts first', () => {
      expect(
        matchReferencedFilesInContent('Full review in `pr-review.md`; see `docs/API.md`.', {
          artifacts: ['pr-review.md'],
          workspace: ['docs/API.md'],
        }),
      ).toEqual([artifact('pr-review.md'), workspace('docs/API.md')]);
    });

    it('gives a path present in both stores the artifact kind', () => {
      expect(
        matchReferencedFilesInContent('see `notes.md`', {
          artifacts: ['notes.md'],
          workspace: ['notes.md'],
        }),
      ).toEqual([artifact('notes.md')]);
    });

    it('will not match an extension-less word against a workspace file', () => {
      expect(
        matchReferencedFilesInContent('please review the changes carefully', {
          workspace: ['review', 'changes'],
        }),
      ).toEqual([]);
    });

    it('still matches an extension-less artifact the gezel produced', () => {
      expect(
        matchReferencedFilesInContent('wrote the Dockerfile for you', {
          artifacts: ['Dockerfile'],
        }),
      ).toEqual([artifact('Dockerfile')]);
    });

    it('caps a runaway inventory dump', () => {
      const workspacePaths = Array.from({ length: 400 }, (_, i) => `src/file-${i}.ts`);
      const content = workspacePaths.map((p) => `- \`${p}\``).join('\n');
      expect(matchReferencedFilesInContent(content, { workspace: workspacePaths })).toHaveLength(
        50,
      );
    });
  });

  it('reuses a prebuilt index across messages', () => {
    const index = buildFileInventoryIndex({ workspace: ['docs/API.md'] });
    expect(matchReferencedFilesWithIndex('a `docs/API.md`', index)).toEqual([
      workspace('docs/API.md'),
    ]);
    expect(matchReferencedFilesWithIndex('b `docs/API.md:12`', index)).toEqual([
      workspace('docs/API.md'),
    ]);
  });
});

describe('artifactPathsOf', () => {
  it('projects only artifacts, for older clients', () => {
    expect(artifactPathsOf([artifact('a.md'), workspace('src/b.ts'), artifact('c.md')])).toEqual([
      'a.md',
      'c.md',
    ]);
  });
});

describe('extractReferencedFiles (with Store)', () => {
  let tmp: string;
  let store: Store;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gezel-refs-'));
    store = new Store({ home: tmp });
    await store.ensureLayout();
    await store.writeProjectArtifact('default', 'index.html', '<h1>Home</h1>');
    await store.writeProjectArtifact('default', 'about.html', '<h1>About</h1>');
    await store.writeProjectArtifact('default', 'styles/main.css', 'body{}');
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });
  const writeWorkspaceFile = async (path: string, content: string) => {
    const full = join(await store.projectWorkspaceDir('default'), path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  };

  it('resolves real artifacts written to the project', async () => {
    expect(
      await extractReferencedFiles(
        store,
        'default',
        'Built `index.html` and `about.html` with styles in `styles/main.css`.',
      ),
    ).toEqual([artifact('about.html'), artifact('index.html'), artifact('styles/main.css')]);
  });

  it('merges an injected workspace listing', async () => {
    expect(
      await extractReferencedFiles(store, 'default', 'Built `index.html` from `src/build.ts:12`.', {
        workspaceFiles: ['src/build.ts'],
      }),
    ).toEqual([artifact('index.html'), workspace('src/build.ts')]);
  });

  it('returns [] when the project has no files', async () => {
    expect(
      await extractReferencedFiles(store, 'empty-project', 'Talks about `index.html`'),
    ).toEqual([]);
  });

  it('ignores mentions that do not match any real file', async () => {
    expect(
      await extractReferencedFiles(store, 'default', 'We should add `imaginary.html` later.'),
    ).toEqual([]);
  });

  it('links a workspace file the index has not listed yet', async () => {
    // The turn that publishes a deck names it before the indexer's next
    // pass, so the persisted listing never has it.
    await writeWorkspaceFile('powerpoint/task-13/deck.pptx', 'PK');
    expect(
      await extractReferencedFiles(
        store,
        'default',
        'Final path: `powerpoint/task-13/deck.pptx`; missing: `powerpoint/task-13/gone.pptx`.',
        { workspaceFiles: ['README.md'] },
      ),
    ).toEqual([workspace('powerpoint/task-13/deck.pptx')]);
  });

  it('reads a drawer prefix as the drawer it names', async () => {
    await writeWorkspaceFile('powerpoint/task-13/deck.pptx', 'PK');
    await store.writeProjectArtifact('default', 'tasks/13/outline.md', '# Outline');
    expect(
      await extractReferencedFiles(
        store,
        'default',
        'Deliverable `workspace/powerpoint/task-13/deck.pptx`, outline `artifacts/tasks/13/outline.md`.',
      ),
    ).toEqual([artifact('tasks/13/outline.md'), workspace('powerpoint/task-13/deck.pptx')]);
  });
});

describe('unresolvedQualifiedPaths', () => {
  it('offers only folder-qualified, extension-bearing workspace candidates', () => {
    expect(
      unresolvedQualifiedPaths(
        'See `deck.pptx`, `docs/known.md`, `artifacts/tasks/1/x.md`, `workspace/out/deck.pptx`, and `src/notes`.',
        [workspace('docs/known.md')],
      ),
    ).toEqual(['out/deck.pptx']);
  });
});

describe('createWorkspaceFileProbe', () => {
  it('spends a shared budget and never stats a path twice', async () => {
    const statted: string[] = [];
    const probe = createWorkspaceFileProbe(
      {
        statProjectWorkspacePath: async (_id: string, path: string) => {
          statted.push(path);
          return path === 'a/real.md' ? { kind: 'file' as const } : { kind: 'missing' as const };
        },
      },
      'default',
    );
    const budget = { remaining: 2 };
    expect(await probe(['a/real.md', 'b/none.md', 'c/over.md'], budget)).toEqual([
      workspace('a/real.md'),
    ]);
    expect(budget.remaining).toBe(0);
    expect(await probe(['a/real.md'], budget)).toEqual([workspace('a/real.md')]);
    expect(statted).toEqual(['a/real.md', 'b/none.md']);
  });
});

describe('createFileStatResolver', () => {
  /** A fake store holding `project:kind:path` keys; records every stat. */
  function fakeStore(files: string[]) {
    const real = new Set(files);
    const statted: string[] = [];
    const stat = (kind: string) => async (projectId: string, path: string) => {
      statted.push(`${projectId}:${kind}:${path}`);
      return real.has(`${projectId}:${kind}:${path}`)
        ? { kind: 'file' as const }
        : { kind: 'missing' as const };
    };
    return {
      statted,
      store: {
        statProjectArtifactPath: stat('artifact'),
        statProjectWorkspacePath: stat('workspace'),
      },
    };
  }

  it('finds the files a card names in either store', async () => {
    const { store } = fakeStore([
      'default:artifact:tasks/12/report.pdf',
      'default:workspace:pdf/task-12/report.md',
    ]);
    const resolve = createFileStatResolver(store);
    expect(
      await resolve(
        '**Report** is finished.\n\n- `tasks/12/report.pdf`\n- `pdf/task-12/report.md`\n- `tasks/12/gone.md`',
        ['default'],
      ),
    ).toEqual([
      { ...artifact('tasks/12/report.pdf'), projectId: 'default' },
      { ...workspace('pdf/task-12/report.md'), projectId: 'default' },
    ]);
  });

  it('takes the first project that has the file', async () => {
    const { store } = fakeStore([
      'trip:artifact:tasks/2/plan.md',
      'default:artifact:tasks/2/plan.md',
    ]);
    const resolve = createFileStatResolver(store);
    expect(await resolve('`tasks/2/plan.md`', ['trip', 'default'])).toEqual([
      { ...artifact('tasks/2/plan.md'), projectId: 'trip' },
    ]);
  });

  it('reads a drawer prefix as the only store to check', async () => {
    const { store, statted } = fakeStore(['default:workspace:decks/q3.pptx']);
    const resolve = createFileStatResolver(store);
    expect(await resolve('`workspace/decks/q3.pptx`', ['default'])).toEqual([
      { ...workspace('decks/q3.pptx'), projectId: 'default' },
    ]);
    expect(statted).toEqual(['default:workspace:decks/q3.pptx']);
  });

  it('never stats a word, and never the same path twice', async () => {
    const { store, statted } = fakeStore(['default:artifact:notes.md']);
    const resolve = createFileStatResolver(store);
    await resolve('Review the notes in `notes.md` and notes.md again.', ['default']);
    await resolve('Also `notes.md`.', ['default']);
    expect(statted).toEqual(['default:artifact:notes.md']);
  });

  it('checks folder-qualified paths before running out of budget', async () => {
    const { store } = fakeStore(['default:artifact:out/final.md']);
    const resolve = createFileStatResolver(store);
    const versions = Array.from({ length: MAX_STAT_TOKENS_PER_TEXT }, (_, i) => `v1.${i}`);
    expect(await resolve(`${versions.join(' ')} then \`out/final.md\``, ['default'])).toEqual([
      { ...artifact('out/final.md'), projectId: 'default' },
    ]);
  });
});
