import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REPARSE_EXIT,
  comparablePath,
  isWithin,
  linkTextTarget,
  runReparseSweepCli,
  sweepIsClean,
  sweepReparsePoints,
} from './reparse-sweep.js';

const isWindows = process.platform === 'win32';
const runsAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let scratch: string;
let root: string;
let realRoot: string;
let outside: string;
let marker: string;

/** Junctions need no privilege on Windows, and are what uv and pnpm create there. */
function linkDir(target: string, at: string): void {
  symlinkSync(target, at, isWindows ? 'junction' : 'dir');
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function expectOutsideUntouched(): void {
  expect(statSync(outside).isDirectory()).toBe(true);
  expect(readFileSync(marker, 'utf8')).toBe('outside bytes');
  expect(readdirSync(outside).sort()).toEqual(['marker.txt', 'sub']);
}

function cli(args: string[]): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = runReparseSweepCli(args, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'gezel-reparse-'));
  root = join(scratch, 'Gezel');
  outside = join(scratch, 'elsewhere');
  mkdirSync(root);
  mkdirSync(join(outside, 'sub'), { recursive: true });
  marker = join(outside, 'marker.txt');
  writeFileSync(marker, 'outside bytes');
  realRoot = realpathSync.native(root);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('neutralize-reparse-points packaging', () => {
  it('ships the CLI as a real unpacked installer resource', () => {
    const appRoot = new URL('../', import.meta.url);
    const tsup = readFileSync(new URL('tsup.config.ts', appRoot), 'utf8');
    const builder = readFileSync(new URL('electron-builder.yml', appRoot), 'utf8');
    expect(tsup).toContain("'neutralize-reparse-points': 'src/neutralize-reparse-points.ts'");
    // Once under `files`, once under `asarUnpack`: node.exe cannot read app.asar.
    expect(builder.match(/^ {2}- dist\/neutralize-reparse-points\.js$/gm)).toHaveLength(2);
  });
});

describe('Windows path comparison', () => {
  it('compares NTFS paths case-insensitively and without the verbatim prefix', () => {
    const gezel = 'C:\\ProgramData\\Gezel';
    expect(isWithin('c:\\programdata\\gezel\\appdata\\uv', gezel, 'win32')).toBe(true);
    expect(isWithin('\\\\?\\C:\\ProgramData\\Gezel\\shared', gezel, 'win32')).toBe(true);
    expect(isWithin('C:\\ProgramData\\Gezel', gezel, 'win32')).toBe(true);
    expect(isWithin('C:\\ProgramData\\Gezel\\', gezel, 'win32')).toBe(true);
    expect(isWithin('C:\\ProgramData\\Gezel\\a\\..\\..\\Users', gezel, 'win32')).toBe(false);
    expect(isWithin('C:\\ProgramData\\GezelEvil\\x', gezel, 'win32')).toBe(false);
    expect(isWithin('C:\\ProgramData', gezel, 'win32')).toBe(false);
    expect(isWithin('D:\\ProgramData\\Gezel\\x', gezel, 'win32')).toBe(false);
    expect(isWithin('\\\\?\\UNC\\host\\share\\Gezel', gezel, 'win32')).toBe(false);
    expect(comparablePath('\\\\?\\UNC\\host\\share\\x', 'win32')).toBe('\\\\host\\share\\x');
    expect(isWithin('C:\\x', 'C:\\', 'win32')).toBe(true);
  });

  it('resolves relative link text against the directory holding the link', () => {
    expect(
      linkTextTarget(
        'C:\\ProgramData\\Gezel\\appdata\\uv\\python\\cpython-3.12-windows-x86_64-none',
        'cpython-3.12.13-windows-x86_64-none',
        'win32',
      ),
    ).toBe('C:\\ProgramData\\Gezel\\appdata\\uv\\python\\cpython-3.12.13-windows-x86_64-none');
    expect(linkTextTarget('/data/Gezel/a/link', '../../etc', 'linux')).toBe('/data/etc');
    expect(isWithin('/data/Gezel', '/data/Gezel', 'linux')).toBe(true);
    // Case matters on POSIX.
    expect(isWithin('/data/gezel/x', '/data/Gezel', 'linux')).toBe(false);
  });
});

describe('sweepReparsePoints', () => {
  it('keeps a link to a sibling inside the root, as uv makes for its Python minor version', () => {
    const python = join(root, 'appdata', 'uv', 'python');
    const patch = join(python, 'cpython-3.12.13-windows-x86_64-none');
    const minor = join(python, 'cpython-3.12-windows-x86_64-none');
    mkdirSync(patch, { recursive: true });
    writeFileSync(join(patch, 'python.exe'), 'interpreter');
    linkDir(patch, minor);
    // pnpm's layout: a package name linked into the virtual store beside it.
    const store = join(
      root,
      'system-toolsets',
      'node_modules',
      '.pnpm',
      'foo@1.0.0',
      'node_modules',
      'foo',
    );
    mkdirSync(store, { recursive: true });
    linkDir(store, join(root, 'system-toolsets', 'node_modules', 'foo'));

    const result = sweepReparsePoints({ root, mode: 'fix' });

    expect(result.links).toBe(2);
    expect(result.kept).toBe(2);
    expect(result.removed).toEqual([]);
    expect(sweepIsClean(result)).toBe(true);
    expect(lstatSync(minor).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(minor, 'python.exe'), 'utf8')).toBe('interpreter');
  });

  it('removes a link that leads outside the root and leaves its target alone', () => {
    const link = join(root, 'shared', 'projects', 'p1', 'escape');
    mkdirSync(join(root, 'shared', 'projects', 'p1'), { recursive: true });
    linkDir(outside, link);

    const lines: string[] = [];
    const result = sweepReparsePoints({ root, mode: 'fix', log: (line) => lines.push(line) });

    expect(result.removed.map((f) => [f.path, f.reason])).toEqual([
      [join(realRoot, 'shared', 'projects', 'p1', 'escape'), 'outside'],
    ]);
    expect(sweepIsClean(result)).toBe(true);
    expect(exists(link)).toBe(false);
    expect(statSync(join(root, 'shared', 'projects', 'p1')).isDirectory()).toBe(true);
    expectOutsideUntouched();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('removed outside link');
    expect(lines[0]).toContain('escape');
  });

  it('removes dangling links whether their text points inside or outside', () => {
    linkDir(join(root, 'never-created'), join(root, 'dangling-inside'));
    linkDir(join(outside, 'never-created'), join(root, 'dangling-outside'));

    const result = sweepReparsePoints({ root, mode: 'fix' });

    const reasons = Object.fromEntries(result.removed.map((f) => [f.path, f.reason]));
    expect(reasons).toEqual({
      [join(realRoot, 'dangling-inside')]: 'unresolvable',
      [join(realRoot, 'dangling-outside')]: 'outside',
    });
    expect(exists(join(root, 'dangling-inside'))).toBe(false);
    expect(exists(join(root, 'dangling-outside'))).toBe(false);
    expect(sweepIsClean(result)).toBe(true);
  });

  it('finds links nested deep in the tree and below a kept link’s target', () => {
    const deep = join(root, 'a', 'b', 'c', 'd');
    mkdirSync(deep, { recursive: true });
    linkDir(outside, join(deep, 'deep-escape'));
    const real = join(root, 'real');
    mkdirSync(real);
    linkDir(join(outside, 'sub'), join(real, 'inner-escape'));
    linkDir(real, join(root, 'alias'));

    const result = sweepReparsePoints({ root, mode: 'fix' });

    expect(result.removed.map((f) => f.path).sort()).toEqual(
      [
        join(realRoot, 'a', 'b', 'c', 'd', 'deep-escape'),
        join(realRoot, 'real', 'inner-escape'),
      ].sort(),
    );
    expect(result.kept).toBe(1);
    expect(lstatSync(join(root, 'alias')).isSymbolicLink()).toBe(true);
    expect(exists(join(root, 'alias', 'inner-escape'))).toBe(false);
    expectOutsideUntouched();
  });

  it('removes link loops without hanging', () => {
    linkDir(join(root, 'loop-b'), join(root, 'loop-a'));
    linkDir(join(root, 'loop-a'), join(root, 'loop-b'));
    linkDir(join(root, 'self'), join(root, 'self'));

    const result = sweepReparsePoints({ root, mode: 'fix' });

    expect(result.removed.map((f) => f.path).sort()).toEqual(
      ['loop-a', 'loop-b', 'self'].map((name) => join(realRoot, name)),
    );
    // Each is removed as a cycle, or (once a peer on its loop is flagged
    // first in the same round) as going through that now-unsafe link.
    expect(result.removed.every((f) => f.reason === 'cycle' || f.reason === 'unresolvable')).toBe(
      true,
    );
    expect(result.kept).toBe(0);
    expect(readdirSync(root)).toEqual([]);
  });

  it('removes links that would send a recursive sweep around a cycle, keeping the rest', () => {
    mkdirSync(join(root, 'sub'));
    linkDir(root, join(root, 'sub', 'up'));
    mkdirSync(join(root, 'a'));
    mkdirSync(join(root, 'b'));
    linkDir(join(root, 'b'), join(root, 'a', 'to-b'));
    linkDir(join(root, 'a'), join(root, 'b', 'to-a'));
    // Leads into the cycle without being on it.
    linkDir(join(root, 'a'), join(root, 'upstream'));
    // Resolves inside, but only through a cycle link that is about to go.
    linkDir(join(root, 'a', 'to-b'), join(root, 'via-cycle'));

    const result = sweepReparsePoints({ root, mode: 'fix' });

    expect(result.removed.map((f) => [f.path, f.reason]).sort()).toEqual(
      [
        [join(realRoot, 'a', 'to-b'), 'cycle'],
        [join(realRoot, 'b', 'to-a'), 'cycle'],
        [join(realRoot, 'sub', 'up'), 'cycle'],
        [join(realRoot, 'via-cycle'), 'unresolvable'],
      ].sort(),
    );
    expect(lstatSync(join(root, 'upstream')).isSymbolicLink()).toBe(true);
    expect(result.kept).toBe(1);
    // The read-only pass the installer runs next must agree the tree is clean.
    expect(sweepIsClean(sweepReparsePoints({ root, mode: 'check' }))).toBe(true);
  });

  it('never resolves a link through one that leads outside', () => {
    linkDir(outside, join(root, 'escape'));
    linkDir(join(root, 'escape', 'sub'), join(root, 'via'));

    const result = sweepReparsePoints({ root, mode: 'fix' });

    const byPath = Object.fromEntries(result.removed.map((f) => [f.path, f]));
    expect(byPath[join(realRoot, 'escape')]?.reason).toBe('outside');
    expect(byPath[join(realRoot, 'via')]?.reason).toBe('unresolvable');
    expect(byPath[join(realRoot, 'via')]?.detail).toContain('goes through unsafe link');
    expectOutsideUntouched();
  });

  it('resolves a multi-link chain by text, never following it onto its outside target', () => {
    // a -> b -> c -> outside, with a processed before b. Pass 1 flags only c
    // (its own text is outside); the chain walk must reach c by text and stop,
    // never realpath a onto `outside` (which on Windows could be a UNC share).
    linkDir(outside, join(root, 'c'));
    linkDir(join(root, 'c'), join(root, 'b'));
    linkDir(join(root, 'b'), join(root, 'a'));

    for (const mode of ['check', 'fix'] as const) {
      const result = sweepReparsePoints({ root, mode });
      const byPath = Object.fromEntries(result.unsafe.map((f) => [f.path, f]));
      expect(byPath[join(realRoot, 'c')]?.reason).toBe('outside');
      for (const near of ['a', 'b']) {
        expect(byPath[join(realRoot, near)]?.reason, near).toBe('unresolvable');
        expect(byPath[join(realRoot, near)]?.detail, near).toContain('goes through unsafe link');
        // The chain stops at c; it never records the outside target.
        expect(byPath[join(realRoot, near)]?.target, near).not.toContain('elsewhere');
      }
      expectOutsideUntouched();
      if (mode === 'check') {
        expect(lstatSync(join(root, 'a')).isSymbolicLink()).toBe(true);
      } else {
        expect(exists(join(root, 'a'))).toBe(false);
        expect(exists(join(root, 'b'))).toBe(false);
        expect(exists(join(root, 'c'))).toBe(false);
      }
      // Re-plant for the second mode.
      if (mode === 'check') {
        /* nothing removed */
      } else {
        linkDir(outside, join(root, 'c'));
        linkDir(join(root, 'c'), join(root, 'b'));
        linkDir(join(root, 'b'), join(root, 'a'));
      }
    }
  });

  it('refuses to delete an unsafe link under a protected subtree and fails closed', () => {
    // The data-root pass passes --no-remove-under=<shared>: a link leading out
    // of the tree, planted in the world-writable shared tree, must not be
    // deleted by the elevated process — it fails the install closed instead.
    const shared = join(root, 'shared');
    mkdirSync(join(shared, 'projects'), { recursive: true });
    linkDir(outside, join(shared, 'projects', 'escape'));
    // A legitimate in-tree junction in the same protected area is kept, not failed.
    mkdirSync(join(shared, 'projects', 'store'), { recursive: true });
    linkDir(join(shared, 'projects', 'store'), join(shared, 'projects', 'dep'));
    // An unsafe link OUTSIDE the protected subtree is still removed.
    linkDir(outside, join(root, 'appdata-escape'));

    const result = sweepReparsePoints({ root, mode: 'fix', noRemoveUnder: [shared] });

    expect(result.removed.map((f) => f.path)).toEqual([join(realRoot, 'appdata-escape')]);
    expect(result.failed.map((f) => [f.path, f.reason])).toEqual([
      [join(realRoot, 'shared', 'projects', 'escape'), 'outside'],
    ]);
    expect(result.failed[0]?.error).toContain('refusing');
    expect(sweepIsClean(result)).toBe(false);
    expect(cli([`--root=${root}`, `--no-remove-under=${shared}`]).code).toBe(
      REPARSE_EXIT.unsafeRemains,
    );
    // The protected link and its target are untouched; the keep stays.
    expect(lstatSync(join(shared, 'projects', 'escape')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(shared, 'projects', 'dep')).isSymbolicLink()).toBe(true);
    expectOutsideUntouched();
  });

  it('keeps legitimate in-tree junctions under a protected subtree', () => {
    const shared = join(root, 'shared', 'projects', 'p1', 'node_modules');
    mkdirSync(join(shared, '.pnpm', 'dep@1', 'node_modules', 'dep'), { recursive: true });
    linkDir(join(shared, '.pnpm', 'dep@1', 'node_modules', 'dep'), join(shared, 'dep'));

    const result = sweepReparsePoints({
      root,
      mode: 'fix',
      noRemoveUnder: [join(root, 'shared')],
    });

    expect(result.kept).toBe(1);
    expect(result.failed).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(sweepIsClean(result)).toBe(true);
    expect(lstatSync(join(shared, 'dep')).isSymbolicLink()).toBe(true);
  });

  it.skipIf(isWindows)('judges relative link text from the link’s own directory', () => {
    mkdirSync(join(root, 'x'));
    mkdirSync(join(root, 'b'));
    symlinkSync('../b', join(root, 'x', 'rel-in'));
    symlinkSync('../../elsewhere', join(root, 'x', 'rel-out'));

    const result = sweepReparsePoints({ root, mode: 'fix' });

    expect(result.removed.map((f) => [f.path, f.reason])).toEqual([
      [join(realRoot, 'x', 'rel-out'), 'outside'],
    ]);
    expect(lstatSync(join(root, 'x', 'rel-in')).isSymbolicLink()).toBe(true);
    expectOutsideUntouched();
  });

  it('removes a file link that leads outside and keeps one that stays inside', (ctx) => {
    writeFileSync(join(root, 'real.txt'), 'inside bytes');
    try {
      symlinkSync(marker, join(root, 'file-out'), 'file');
      symlinkSync(join(root, 'real.txt'), join(root, 'file-in'), 'file');
    } catch (err) {
      // Windows file symlinks need SeCreateSymbolicLinkPrivilege or Developer Mode.
      if (isWindows && (err as NodeJS.ErrnoException).code === 'EPERM') ctx.skip();
      throw err;
    }

    const result = sweepReparsePoints({ root, mode: 'fix' });

    expect(result.removed.map((f) => [f.path, f.reason])).toEqual([
      [join(realRoot, 'file-out'), 'outside'],
    ]);
    expect(readFileSync(join(root, 'file-in'), 'utf8')).toBe('inside bytes');
    expectOutsideUntouched();
  });

  it('reports without changing anything in check mode', () => {
    linkDir(outside, join(root, 'escape'));
    linkDir(join(root, 'missing'), join(root, 'dangling'));

    const result = sweepReparsePoints({ root, mode: 'check' });

    expect(result.unsafe.map((f) => f.path).sort()).toEqual(
      [join(realRoot, 'dangling'), join(realRoot, 'escape')].sort(),
    );
    expect(result.removed).toEqual([]);
    expect(sweepIsClean(result)).toBe(false);
    expect(lstatSync(join(root, 'escape')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(root, 'dangling')).isSymbolicLink()).toBe(true);
  });

  it('refuses a root that is itself a link', () => {
    const rootLink = join(scratch, 'root-link');
    linkDir(root, rootLink);
    linkDir(outside, join(root, 'escape'));

    expect(() => sweepReparsePoints({ root: rootLink, mode: 'fix' })).toThrow(/itself a link/);
    expect(lstatSync(join(root, 'escape')).isSymbolicLink()).toBe(true);
  });

  it.skipIf(isWindows || runsAsRoot)('fails closed when a link cannot be removed', () => {
    const locked = join(root, 'locked');
    mkdirSync(locked);
    linkDir(outside, join(locked, 'escape'));
    chmodSync(locked, 0o555);
    try {
      const result = sweepReparsePoints({ root, mode: 'fix' });
      expect(result.failed.map((f) => f.path)).toEqual([join(realRoot, 'locked', 'escape')]);
      expect(sweepIsClean(result)).toBe(false);
      expect(cli([`--root=${root}`]).code).toBe(REPARSE_EXIT.unsafeRemains);
      expect(lstatSync(join(locked, 'escape')).isSymbolicLink()).toBe(true);
      expectOutsideUntouched();
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it.skipIf(isWindows || runsAsRoot)('fails closed on a directory it cannot read', () => {
    const hidden = join(root, 'hidden');
    mkdirSync(hidden);
    linkDir(outside, join(hidden, 'escape'));
    chmodSync(hidden, 0o000);
    try {
      const result = sweepReparsePoints({ root, mode: 'fix' });
      expect(result.uninspectable.map((entry) => entry.path)).toEqual([join(realRoot, 'hidden')]);
      expect(sweepIsClean(result)).toBe(false);
      expect(cli([`--root=${root}`]).code).toBe(REPARSE_EXIT.uninspectable);
    } finally {
      chmodSync(hidden, 0o755);
    }
    expect(lstatSync(join(hidden, 'escape')).isSymbolicLink()).toBe(true);
  });
});

describe('runReparseSweepCli', () => {
  it('removes, logs one line per link plus a summary, and then checks clean', () => {
    linkDir(outside, join(root, 'escape'));
    mkdirSync(join(root, 'kept-target'));
    linkDir(join(root, 'kept-target'), join(root, 'kept'));

    const fix = cli([`--root=${root}`]);
    expect(fix.code).toBe(REPARSE_EXIT.clean);
    expect(fix.err).toEqual([]);
    expect(fix.out).toHaveLength(2);
    expect(fix.out[0]).toMatch(/^\[neutralize-reparse-points\] removed outside link .*escape -> /);
    expect(fix.out[1]).toMatch(
      /^\[neutralize-reparse-points\] fix root=.* links=2 kept=1 unsafe=1 removed=1 failed=0 uninspectable=0 /,
    );

    const check = cli([`--root=${root}`, '--check']);
    expect(check.code).toBe(REPARSE_EXIT.clean);
    expect(check.out).toHaveLength(1);
    expect(check.out[0]).toContain('check root=');
    expectOutsideUntouched();
  });

  it('exits non-zero in check mode while an unsafe link remains', () => {
    linkDir(outside, join(root, 'escape'));
    const check = cli([`--root=${root}`, '--check']);
    expect(check.code).toBe(REPARSE_EXIT.unsafeRemains);
    expect(check.out[0]).toContain('unsafe outside link');
    expect(exists(join(root, 'escape'))).toBe(true);
  });

  it('rejects bad arguments and roots it cannot sweep', () => {
    expect(cli([]).code).toBe(REPARSE_EXIT.usage);
    expect(cli(['--root=relative/path']).code).toBe(REPARSE_EXIT.usage);
    expect(cli([`--root=${root}`, '--force']).code).toBe(REPARSE_EXIT.usage);
    const missing = cli([`--root=${join(scratch, 'missing')}`]);
    expect(missing.code).toBe(REPARSE_EXIT.usage);
    expect(missing.err[0]).toContain('FAILED');
    expect(existsSync(join(scratch, 'missing'))).toBe(false);
  });
});
