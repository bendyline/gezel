import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import {
  artifactPathsOf,
  buildFileInventoryIndex,
  extractReferencedFiles,
  matchReferencedFilesInContent,
  matchReferencedFilesWithIndex,
  scanPathTokens,
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
});
