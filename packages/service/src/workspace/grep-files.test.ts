import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { rgPath as bundledRipgrepPath } from '@vscode/ripgrep';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ResolvedSearchTarget,
  type SearchPlan,
  buildRipgrepArgs,
  grepWorkspace,
} from './grep-files.js';

const HAS_RIPGREP = spawnSync(bundledRipgrepPath, ['--version'], { stdio: 'ignore' }).status === 0;

let workspaceDir: string;
let outsideDir: string;

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), 'gezel-grep-files-'));
  outsideDir = await mkdtemp(join(tmpdir(), 'gezel-grep-outside-'));
  await Promise.all([
    mkdir(join(workspaceDir, 'src'), { recursive: true }),
    mkdir(join(workspaceDir, 'node_modules', 'fixture'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(workspaceDir, 'src', 'a.ts'), 'zero\nNeedle one\nmiddle\nneedle two\nend\n'),
    writeFile(join(workspaceDir, 'src', 'b.ts'), 'needle in b\n'),
    writeFile(join(workspaceDir, 'src', 'a.test.ts'), 'needle in excluded test\n'),
    writeFile(join(workspaceDir, 'src', 'binary.bin'), Buffer.from('needle\0binary')),
    writeFile(join(workspaceDir, 'node_modules', 'fixture', 'dep.ts'), 'needle dependency\n'),
    writeFile(join(outsideDir, 'sentinel.ts'), 'needle outside\n'),
  ]);
});

afterEach(async () => {
  await Promise.all([
    rm(workspaceDir, { recursive: true, force: true }),
    rm(outsideDir, { recursive: true, force: true }),
  ]);
});

function plan(overrides: Partial<SearchPlan> = {}): SearchPlan {
  return {
    pattern: 'needle',
    caseInsensitive: false,
    literal: true,
    includeGlobs: [],
    excludeGlobs: ['**/.git/**'],
    resultMode: 'matches',
    cursor: 0,
    limit: 50,
    contextLines: 0,
    timeoutMs: 10_000,
    trustedRegex: false,
    ...overrides,
  };
}

function target(overrides: Partial<ResolvedSearchTarget> = {}): ResolvedSearchTarget {
  return {
    workspaceDir: '/workspace',
    cwd: '/workspace',
    target: '.',
    targetIsFile: false,
    ...overrides,
  };
}

async function withFakeRipgrep<T>(source: string, run: () => Promise<T>): Promise<T> {
  const fakeBin = join(outsideDir, 'fake-bin');
  const executable = join(fakeBin, process.platform === 'win32' ? 'rg.cmd' : 'rg');
  const fixture = join(fakeBin, 'fixture.mjs');
  await mkdir(fakeBin, { recursive: true });
  await writeFile(fixture, `${source}\n`);
  if (process.platform === 'win32') {
    await writeFile(
      executable,
      `@echo off\r\nif "%~1"=="--version" (\r\n  echo ripgrep 99.0.0\r\n  exit /b 0\r\n)\r\n"${process.execPath}" "${fixture}" %*\r\n`,
    );
  } else {
    const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
    await writeFile(
      executable,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "ripgrep 99.0.0"\n  exit 0\nfi\nexec ${shellQuote(process.execPath)} ${shellQuote(fixture)} "$@"\n`,
    );
  }
  if (process.platform !== 'win32') await chmod(executable, 0o755);
  const priorPath = process.env.PATH;
  process.env.PATH = fakeBin;
  try {
    return await run();
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
  }
}

describe('ripgrep argument boundary', () => {
  it.each(['-e', '--files', '--pre=touch sentinel'])(
    'places the model-controlled pattern %j after the option delimiter',
    (pattern) => {
      const args = buildRipgrepArgs(
        target(),
        plan({
          pattern,
          includeGlobs: ['**/*.ts', '--type-add=owned:*.owned'],
          excludeGlobs: ['**/vendor/**'],
        }),
      );
      const delimiter = args.indexOf('--');

      expect(args).toContain('--no-config');
      expect(delimiter).toBeGreaterThan(args.indexOf('--max-count'));
      expect(args.slice(delimiter)).toEqual(['--', pattern, '.']);
      expect(args.slice(0, delimiter)).toEqual(
        expect.arrayContaining([
          '--glob',
          '**/*.ts',
          '--glob',
          '--type-add=owned:*.owned',
          '--glob',
          '!**/vendor/**',
        ]),
      );
    },
  );
});

describe('grepWorkspace JavaScript fallback', () => {
  it('returns deterministic context, truthful truncation, and a working cursor', async () => {
    const first = await grepWorkspace({
      workspaceDir,
      engine: 'javascript',
      pattern: 'needle',
      literal: true,
      caseInsensitive: true,
      includeGlobs: ['**/*.ts'],
      excludeGlobs: ['**/*.test.ts'],
      contextLines: 1,
      maxResults: 1,
    });

    expect(first).toMatchObject({
      mode: 'matches',
      truncated: true,
      truncationReason: 'limit',
      nextCursor: 1,
      engine: 'javascript',
    });
    expect(first.matches).toEqual([
      {
        path: 'src/a.ts',
        line: 2,
        text: 'Needle one',
        before: [{ line: 1, text: 'zero' }],
        after: [{ line: 3, text: 'middle' }],
      },
    ]);

    const second = await grepWorkspace({
      workspaceDir,
      engine: 'javascript',
      pattern: 'needle',
      literal: true,
      caseInsensitive: true,
      includeGlobs: ['**/*.ts'],
      excludeGlobs: ['**/*.test.ts'],
      cursor: first.nextCursor,
      maxResults: 1,
    });
    expect(second.matches).toEqual([{ path: 'src/a.ts', line: 4, text: 'needle two' }]);
    expect(second).toMatchObject({ truncated: true, nextCursor: 2 });
  });

  it('does not claim truncation when exactly maxResults matches exist', async () => {
    const result = await grepWorkspace({
      workspaceDir,
      engine: 'javascript',
      path: 'src/a.ts',
      pattern: 'needle',
      literal: true,
      caseInsensitive: true,
      maxResults: 2,
    });

    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(result.nextCursor).toBeUndefined();
  });

  it('supports regular-file paths and keeps default dependency and binary exclusions', async () => {
    const fileResult = await grepWorkspace({
      workspaceDir,
      engine: 'javascript',
      path: 'src/b.ts',
      pattern: 'needle',
      literal: true,
    });
    expect(fileResult.matches).toEqual([{ path: 'src/b.ts', line: 1, text: 'needle in b' }]);

    const all = await grepWorkspace({
      workspaceDir,
      engine: 'javascript',
      pattern: 'needle',
      literal: true,
      caseInsensitive: true,
    });
    expect(all.matches.some((match) => match.path.includes('node_modules'))).toBe(false);
    expect(all.matches.some((match) => match.path.endsWith('binary.bin'))).toBe(false);
  });

  it('supports unique-file and bounded-count result modes', async () => {
    const files = await grepWorkspace({
      workspaceDir,
      engine: 'javascript',
      pattern: 'needle',
      literal: true,
      caseInsensitive: true,
      includeGlobs: ['**/*.ts'],
      excludeGlobs: ['**/*.test.ts'],
      resultMode: 'files',
      maxResults: 1,
    });
    expect(files).toMatchObject({
      mode: 'files',
      files: ['src/a.ts'],
      count: 1,
      truncated: true,
      nextCursor: 1,
    });

    const count = await grepWorkspace({
      workspaceDir,
      engine: 'javascript',
      path: 'src/a.ts',
      pattern: 'needle',
      literal: true,
      caseInsensitive: true,
      resultMode: 'count',
      maxResults: 1,
    });
    expect(count).toMatchObject({ mode: 'count', count: 1, truncated: true });
    expect(count.nextCursor).toBeUndefined();
  });

  it('fails closed for model-supplied regexes when ripgrep is unavailable', async () => {
    await expect(
      grepWorkspace({
        workspaceDir,
        engine: 'javascript',
        pattern: '(needle)+',
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid-request',
    });
  });

  it('keeps plain exact patterns working when a model omits literal', async () => {
    const result = await grepWorkspace({
      workspaceDir,
      engine: 'javascript',
      path: 'src/b.ts',
      pattern: 'needle in b',
    });

    expect(result.matches).toEqual([{ path: 'src/b.ts', line: 1, text: 'needle in b' }]);
  });
});

describe('grepWorkspace path containment', () => {
  it('returns actionable errors for missing and escaping targets', async () => {
    await expect(
      grepWorkspace({
        workspaceDir,
        engine: 'javascript',
        path: 'missing',
        pattern: 'needle',
        literal: true,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'path-not-found' });

    await expect(
      grepWorkspace({
        workspaceDir,
        engine: 'javascript',
        path: '../outside',
        pattern: 'needle',
        literal: true,
      }),
    ).rejects.toMatchObject({ status: 403, code: 'path-safety' });
  });

  it.runIf(process.platform !== 'win32')(
    'rejects outward symlinks while permitting symlinks that resolve inside the workspace',
    async () => {
      await Promise.all([
        symlink(outsideDir, join(workspaceDir, 'escape'), 'dir'),
        symlink(join(workspaceDir, 'src'), join(workspaceDir, 'src-link'), 'dir'),
      ]);

      await expect(
        grepWorkspace({
          workspaceDir,
          engine: 'javascript',
          path: 'escape',
          pattern: 'needle',
          literal: true,
        }),
      ).rejects.toMatchObject({ status: 403, code: 'path-safety' });

      const inside = await grepWorkspace({
        workspaceDir,
        engine: 'javascript',
        path: 'src-link',
        pattern: 'needle in b',
        literal: true,
      });
      expect(inside.matches).toEqual([{ path: 'src/b.ts', line: 1, text: 'needle in b' }]);
    },
  );
});

describe.runIf(HAS_RIPGREP)('grepWorkspace ripgrep engine', () => {
  it('uses the bundled platform binary when rg is absent from PATH', async () => {
    const priorPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const result = await grepWorkspace({
        workspaceDir,
        engine: 'ripgrep',
        path: 'src/b.ts',
        pattern: 'needle\\s+in\\s+b',
      });

      expect(result).toMatchObject({
        engine: 'ripgrep',
        matches: [{ path: 'src/b.ts', line: 1, text: 'needle in b' }],
      });
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
    }
  });

  it('trusts only the package-provided binary when the app reviews its own checkout', async () => {
    const priorPath = process.env.PATH;
    process.env.PATH = '';
    try {
      // @vscode/ripgrep exports <package>/bin/rg(.exe). Making that package
      // root the workspace reproduces self-hosted Gezel development: the old
      // general executable check rejected the bundle merely for being inside
      // the reviewed checkout.
      const packageRoot = dirname(dirname(bundledRipgrepPath));
      const result = await grepWorkspace({
        workspaceDir: packageRoot,
        engine: 'ripgrep',
        path: 'package.json',
        pattern: '"name"',
        literal: true,
      });

      expect(result.engine).toBe('ripgrep');
      expect(result.matches.some((match) => match.path === 'package.json')).toBe(true);
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
    }
  });

  it('treats an option-looking pattern as data and reports invalid regexes', async () => {
    await writeFile(join(workspaceDir, 'src', 'options.txt'), '--pre=echo-owned\n');

    const result = await grepWorkspace({
      workspaceDir,
      engine: 'ripgrep',
      pattern: '--pre=echo-owned',
      literal: true,
    });
    expect(result.matches).toEqual([
      { path: 'src/options.txt', line: 1, text: '--pre=echo-owned' },
    ]);

    await expect(
      grepWorkspace({ workspaceDir, engine: 'ripgrep', pattern: '[' }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid-regex',
    });
  });

  it('matches the JavaScript engine for include, exclude, and default dependency filters', async () => {
    const request = {
      workspaceDir,
      pattern: 'needle',
      literal: true,
      caseInsensitive: true,
      includeGlobs: ['**/*.ts'],
      excludeGlobs: ['**/*.test.ts'],
    };
    const [ripgrep, javascript] = await Promise.all([
      grepWorkspace({ ...request, engine: 'ripgrep' }),
      grepWorkspace({ ...request, engine: 'javascript' }),
    ]);

    expect(ripgrep.matches).toEqual(javascript.matches);
    expect(ripgrep.matches.map((match) => match.path)).toEqual([
      'src/a.ts',
      'src/a.ts',
      'src/b.ts',
    ]);
  });
});

describe.runIf(process.platform !== 'win32')('grepWorkspace ripgrep process contract', () => {
  it('ignores an rg binary supplied through the model-controlled workspace', async () => {
    const workspaceRg = join(workspaceDir, 'rg');
    await writeFile(
      workspaceRg,
      `#!${process.execPath}\nprocess.stdout.write('workspace executable ran');\n`,
    );
    await chmod(workspaceRg, 0o755);
    const priorPath = process.env.PATH;
    process.env.PATH = workspaceDir;
    try {
      const result = await grepWorkspace({
        workspaceDir,
        engine: 'auto',
        path: 'src/b.ts',
        pattern: 'needle in b',
      });
      expect(result.engine).toBe('ripgrep');
      expect(result.matches).toEqual([{ path: 'src/b.ts', line: 1, text: 'needle in b' }]);
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
    }
  });

  it('parses JSON split across chunks, including a split UTF-8 code point', async () => {
    const event = `${JSON.stringify({
      type: 'match',
      data: {
        path: { text: 'src/b.ts' },
        line_number: 1,
        lines: { text: 'naïve needle\n' },
      },
    })}\n`;
    const script = [
      `const bytes = Buffer.from(${JSON.stringify(event)}, 'utf8');`,
      "const marker = Buffer.from('ï', 'utf8');",
      'const cut = bytes.indexOf(marker) + 1;',
      'process.stdout.write(bytes.subarray(0, cut));',
      'setTimeout(() => process.stdout.write(bytes.subarray(cut)), 5);',
    ].join('\n');

    const result = await withFakeRipgrep(script, () =>
      grepWorkspace({
        workspaceDir,
        engine: 'ripgrep',
        pattern: 'needle',
        literal: true,
      }),
    );
    expect(result.matches).toEqual([{ path: 'src/b.ts', line: 1, text: 'naïve needle' }]);
    expect(result.truncated).toBe(false);
  });

  it('treats exit 1 as no matches and surfaces exit 2 as a bounded process error', async () => {
    const noMatches = await withFakeRipgrep('process.exitCode = 1;', () =>
      grepWorkspace({
        workspaceDir,
        engine: 'ripgrep',
        pattern: 'absent',
        literal: true,
      }),
    );
    expect(noMatches).toMatchObject({ matches: [], truncated: false, engine: 'ripgrep' });

    await expect(
      withFakeRipgrep(
        "process.stderr.write('fixture process failure'); process.exitCode = 2;",
        () =>
          grepWorkspace({
            workspaceDir,
            engine: 'ripgrep',
            pattern: 'needle',
            literal: true,
          }),
      ),
    ).rejects.toMatchObject({ status: 500, code: 'process-failed' });
  });

  it('kills a hung process at the deadline', async () => {
    await expect(
      withFakeRipgrep('setInterval(() => {}, 1000);', () =>
        grepWorkspace({
          workspaceDir,
          engine: 'ripgrep',
          pattern: 'needle',
          literal: true,
          timeoutMs: 1_000,
        }),
      ),
    ).rejects.toMatchObject({ status: 504, code: 'timeout' });
  });

  it('kills oversized stdout and returns a bounded partial result', async () => {
    const result = await withFakeRipgrep(
      "process.stdout.write('x'.repeat(3 * 1024 * 1024)); setInterval(() => {}, 1000);",
      () =>
        grepWorkspace({
          workspaceDir,
          engine: 'ripgrep',
          pattern: 'needle',
          literal: true,
        }),
    );

    expect(result).toMatchObject({
      matches: [],
      truncated: true,
      truncationReason: 'output',
      engine: 'ripgrep',
    });
  });
});
