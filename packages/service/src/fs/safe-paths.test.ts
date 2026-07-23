import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PathSafetyError,
  intoWorkspaceRelative,
  isReservedWindowsName,
  realpathContained,
  resolveInside,
  safeJoin,
} from './safe-paths.js';

describe('safeJoin', () => {
  const base = process.platform === 'win32' ? 'C:\\gezel-test\\base' : '/gezel-test/base';

  it('resolves a simple relative path', () => {
    expect(safeJoin(base, 'hello.md')).toBe(join(base, 'hello.md'));
  });

  it('blocks ../ escape', () => {
    expect(safeJoin(base, '../evil.md')).toBe(null);
    expect(safeJoin(base, 'foo/../../evil.md')).toBe(null);
  });

  it('blocks absolute input paths', () => {
    expect(safeJoin(base, process.platform === 'win32' ? 'C:\\evil.md' : '/evil.md')).toBe(null);
  });

  it('blocks prefix-without-separator confusion', () => {
    // A candidate of /gezel-test/baseEVIL should NOT be considered inside /gezel-test/base.
    // We can't construct that via join() — that's the point; any user-supplied path
    // that would land there gets rejected.
    const tricky = `..${sep}baseEVIL${sep}file.md`;
    expect(safeJoin(base, tricky)).toBe(null);
  });

  it('allows exact-equal base', () => {
    expect(safeJoin(base, '.')).toBe(base);
  });

  it('rejects non-string input', () => {
    expect(safeJoin(base, null as unknown as string)).toBe(null);
    expect(safeJoin(base, 42 as unknown as string)).toBe(null);
  });

  it('blocks Windows ADS, UNC, device segments, and ambiguous trailing characters', () => {
    expect(safeJoin(base, 'report.txt:secret')).toBe(null);
    expect(safeJoin(base, '\\\\server\\share\\file.txt')).toBe(null);
    expect(safeJoin(base, 'CON/file.txt')).toBe(null);
    expect(safeJoin(base, 'folder./file.txt')).toBe(null);
    expect(safeJoin(base, 'file.txt ')).toBe(null);
  });
});

describe('intoWorkspaceRelative', () => {
  const base =
    process.platform === 'win32' ? 'C:\\gh\\client-project' : '/Users/dev/gh/client-project';
  const abs = (p: string) => (process.platform === 'win32' ? `${base}\\${p}` : `${base}/${p}`);

  it('passes a relative path through unchanged', () => {
    expect(intoWorkspaceRelative(base, 'AGENTS.md')).toBe('AGENTS.md');
    expect(intoWorkspaceRelative(base, 'src/index.ts')).toBe('src/index.ts');
    expect(intoWorkspaceRelative(base, '')).toBe('');
  });

  it('rebases an absolute path inside the workspace to relative', () => {
    expect(intoWorkspaceRelative(base, abs('AGENTS.md'))).toBe('AGENTS.md');
    expect(intoWorkspaceRelative(base, abs('packages/core/src/paths.ts'))).toBe(
      join('packages', 'core', 'src', 'paths.ts'),
    );
  });

  it('collapses an absolute path equal to the base to empty', () => {
    expect(intoWorkspaceRelative(base, base)).toBe('');
  });

  it('throws an actionable error for an absolute path outside the workspace', () => {
    const outside = process.platform === 'win32' ? 'C:\\etc\\passwd' : '/etc/passwd';
    expect(() => intoWorkspaceRelative(base, outside)).toThrow(PathSafetyError);
    expect(() => intoWorkspaceRelative(base, outside)).toThrow(/outside the workspace/);
  });

  it('does not treat a sibling with a shared prefix as inside', () => {
    // /Users/dev/gh/client-project-secrets must not resolve under
    // /Users/dev/gh/client-project.
    const sibling = `${base}-secrets${process.platform === 'win32' ? '\\' : '/'}x.txt`;
    expect(() => intoWorkspaceRelative(base, sibling)).toThrow(PathSafetyError);
  });

  it('is case-insensitive on macOS/Windows for the containment decision', () => {
    if (process.platform === 'linux') return; // case-sensitive FS — skip
    expect(intoWorkspaceRelative(base, abs('AGENTS.md').toUpperCase())).toBe('AGENTS.MD');
  });
});

describe('realpathContained + resolveInside — symlink escape', () => {
  let base: string;
  let outside: string;

  beforeAll(async () => {
    base = join(tmpdir(), `gezel-paths-test-${Date.now()}`);
    outside = join(tmpdir(), `gezel-paths-outside-${Date.now()}`);
    await mkdir(base, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'nope');
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('passes containment for a normal child path', async () => {
    await writeFile(join(base, 'ok.md'), 'hello');
    expect(await realpathContained(base, join(base, 'ok.md'))).toBe(true);
  });

  it('catches a symlink that escapes the base', async () => {
    const linkPath = join(base, 'escape');
    try {
      await symlink(outside, linkPath, 'dir');
    } catch (err) {
      if (process.platform === 'win32') {
        // Symlink creation may require elevated permissions on Windows —
        // skip rather than failing when the test env can't set up the
        // fixture.
        return;
      }
      throw err;
    }
    const through = join(linkPath, 'secret.txt');
    expect(await realpathContained(base, through)).toBe(false);
    await expect(resolveInside(base, 'escape/secret.txt')).rejects.toBeInstanceOf(PathSafetyError);
  });
});

describe('isReservedWindowsName', () => {
  it('catches classic reserved names', () => {
    expect(isReservedWindowsName('CON')).toBe(true);
    expect(isReservedWindowsName('con')).toBe(true);
    expect(isReservedWindowsName('PRN')).toBe(true);
    expect(isReservedWindowsName('com1')).toBe(true);
    expect(isReservedWindowsName('LPT9')).toBe(true);
  });

  it('catches reserved names with extensions', () => {
    // `CON.txt` is also reserved per Win32 rules.
    expect(isReservedWindowsName('CON.txt')).toBe(true);
    expect(isReservedWindowsName('nul.md')).toBe(true);
  });

  it('does not flag legitimate names that share a prefix', () => {
    expect(isReservedWindowsName('conference')).toBe(false);
    expect(isReservedWindowsName('printer.md')).toBe(false);
    expect(isReservedWindowsName('com10')).toBe(false);
    expect(isReservedWindowsName('lptFoo')).toBe(false);
  });
});

describe('resolveInside — end-to-end', () => {
  let base: string;

  beforeAll(async () => {
    base = join(tmpdir(), `gezel-resolve-test-${Date.now()}`);
    await mkdir(base, { recursive: true });
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('rejects empty path', async () => {
    await expect(resolveInside(base, '')).rejects.toThrow(/empty path/);
  });

  it('rejects path-traversal', async () => {
    await expect(resolveInside(base, '../../etc/passwd')).rejects.toThrow(/escapes the base dir/);
  });

  it('rejects reserved Windows basename', async () => {
    await expect(resolveInside(base, 'CON')).rejects.toThrow(/reserved Windows name/);
    await expect(resolveInside(base, 'src/CON.ts')).rejects.toThrow(/reserved Windows name/);
  });

  it('resolves a legitimate nested path', async () => {
    const out = await resolveInside(base, 'src/index.ts');
    expect(out).toBe(join(base, 'src', 'index.ts'));
  });

  it('rebases an absolute path inside the base', async () => {
    const out = await resolveInside(base, join(base, 'src', 'index.ts'));
    expect(out).toBe(join(base, 'src', 'index.ts'));
  });

  it('rejects an absolute path outside the base', async () => {
    const outside = process.platform === 'win32' ? 'C:\\etc\\passwd' : '/etc/passwd';
    await expect(resolveInside(base, outside)).rejects.toThrow(/outside the workspace/);
  });
});
