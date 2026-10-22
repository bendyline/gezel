import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { HarnessConnectResponse, UnifiedSearchResult } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  absoluteForHit,
  absoluteFromApp,
  relativeInside,
  rootedPath,
  whereFilesMayBe,
} from './paths.js';
import type { HarnessBinding } from './session.js';

const root = resolve(tmpdir(), 'gezel-harness-paths');
const folder = join(root, 'repo');
const library = join(root, 'library');
const artifacts = join(root, 'artifacts');

function binding(
  info: Partial<HarnessConnectResponse> | null = {},
  extra: Partial<HarnessBinding> = {},
): HarnessBinding {
  return {
    key: 'k',
    request: { client: 'claude-code' },
    ...extra,
    ...(info
      ? {
          info: {
            token: 'T',
            appId: 'harness:claude-code:repo',
            project: {
              id: 'repo',
              name: 'repo',
              workingDir: folder,
              readOnly: true,
              created: false,
            },
            libraryDir: library,
            artifactsDir: artifacts,
            memory: 'save',
            images: 'local',
            ...info,
          },
        }
      : {}),
  };
}

function hit(overrides: Partial<UnifiedSearchResult>): UnifiedSearchResult {
  return { kind: 'content', id: 'h', title: 't', score: 1, ...overrides };
}

describe('relativeInside', () => {
  it('answers the forward-slashed path inside the root', () => {
    expect(relativeInside(folder, join(folder, 'src', 'index.ts'))).toBe('src/index.ts');
    expect(relativeInside(folder, folder)).toBe('');
  });

  it('refuses a path outside the root, including a sibling that shares its prefix', () => {
    expect(relativeInside(folder, library)).toBeNull();
    expect(relativeInside(folder, `${folder}-other`)).toBeNull();
  });
});

describe('absoluteFromApp', () => {
  it('keeps an absolute path', () => {
    expect(absoluteFromApp(binding(), join(library, 'a.md'))).toBe(join(library, 'a.md'));
  });

  it('reads a relative path from the folder the app named, else the project folder', () => {
    const other = join(root, 'elsewhere');
    expect(absoluteFromApp(binding({}, { folder: other }), 'a.ts')).toBe(join(other, 'a.ts'));
    expect(absoluteFromApp(binding(), 'src/a.ts')).toBe(join(folder, 'src', 'a.ts'));
  });
});

describe('rootedPath', () => {
  it('places a path in the workspace, the library, or the artifacts', () => {
    expect(rootedPath(binding(), join(folder, 'src', 'a.ts'))).toEqual({
      root: 'workspace',
      rel: 'src/a.ts',
      abs: join(folder, 'src', 'a.ts'),
    });
    expect(rootedPath(binding(), join(library, 'guide.md'))?.root).toBe('library');
    expect(rootedPath(binding(), join(artifacts, 'out.png'))?.root).toBe('artifacts');
  });

  it('refuses a root itself and anything outside every root', () => {
    expect(rootedPath(binding(), folder)).toBeNull();
    expect(rootedPath(binding(), join(root, 'elsewhere', 'a.ts'))).toBeNull();
    expect(rootedPath(binding(null), join(folder, 'a.ts'))).toBeNull();
  });
});

describe('whereFilesMayBe', () => {
  it('names the project folder and the library', () => {
    expect(whereFilesMayBe(binding())).toBe(
      `the folder Gezel knows as "repo" (${folder}) or the shared library (${library})`,
    );
  });

  it('falls back to the shared library when nothing is known', () => {
    expect(whereFilesMayBe(binding(null))).toBe('the shared library');
  });
});

describe('absoluteForHit', () => {
  it('maps each corpus to its folder on this computer', () => {
    expect(absoluteForHit(binding(), hit({ path: 'src/a.ts', source: 'workspace' }))).toBe(
      join(folder, 'src/a.ts'),
    );
    expect(
      absoluteForHit(binding(), hit({ path: 'report.md', retrievalSource: 'artifacts' })),
    ).toBe(join(artifacts, 'report.md'));
    expect(
      absoluteForHit(
        binding(),
        hit({ path: 'policy.md', retrievalSource: 'shared', projectId: 'shared' }),
      ),
    ).toBe(join(library, 'policy.md'));
  });

  it('answers null for another project, a hit with no path, or an unknown root', () => {
    expect(
      absoluteForHit(
        binding(),
        hit({ path: 'a.ts', retrievalSource: 'workspace', projectId: 'other' }),
      ),
    ).toBeNull();
    expect(absoluteForHit(binding(), hit({ retrievalSource: 'workspace' }))).toBeNull();
    expect(
      absoluteForHit(
        binding({ project: { id: 'repo', name: 'repo', readOnly: true, created: false } }),
        hit({ path: 'a.ts', retrievalSource: 'workspace' }),
      ),
    ).toBeNull();
  });
});
