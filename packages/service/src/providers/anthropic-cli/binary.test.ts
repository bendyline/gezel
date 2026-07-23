import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeBinaryNotFoundError, resolveClaudeBinary, which } from './binary.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-claude-cli-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function makeFakeClaude(stdout: string, exitCode = 0): Promise<string> {
  if (process.platform === 'win32') {
    // Windows: write a .cmd shim so the loader can exec it AND `which`
    // (which iterates PATHEXT extensions) can find it. `<NUL` keeps the
    // BatchFile from waiting on stdin if --version is invoked
    // interactively. `set /p=` echoes without a trailing newline; we
    // simulate the POSIX `printf '%s'` by emitting the string then the
    // explicit \n that the original test produced.
    const path = join(dir, 'claude.cmd');
    const escaped = stdout.replace(/[\r\n]+$/, '').replaceAll('%', '%%');
    const script = `@echo off\r\n<NUL set /p =${escaped}\r\necho.\r\nexit /b ${exitCode}\r\n`;
    await writeFile(path, script, 'utf8');
    return path;
  }
  const path = join(dir, 'claude');
  const script = `#!/bin/sh\nprintf '%s' '${stdout.replaceAll("'", "'\\''")}'\nexit ${exitCode}\n`;
  await writeFile(path, script, 'utf8');
  await chmod(path, 0o755);
  return path;
}

describe('resolveClaudeBinary', () => {
  it('returns the override when its --version probe succeeds', async () => {
    const path = await makeFakeClaude('1.2.3 (Claude Code)\n');
    const out = await resolveClaudeBinary({ override: path });
    expect(out.path).toBe(path);
    expect(out.version).toBe('1.2.3 (Claude Code)');
  });

  it('throws an actionable error when nothing on PATH and no override', async () => {
    await expect(resolveClaudeBinary({ env: { PATH: dir } })).rejects.toBeInstanceOf(
      ClaudeBinaryNotFoundError,
    );
  });

  it('throws an actionable error when the override exists but exits non-zero', async () => {
    const path = await makeFakeClaude('boom', 7);
    await expect(resolveClaudeBinary({ override: path })).rejects.toBeInstanceOf(
      ClaudeBinaryNotFoundError,
    );
  });

  it('finds a binary on PATH when no override is set', async () => {
    const path = await makeFakeClaude('2.0.0\n');
    const out = await resolveClaudeBinary({ env: { PATH: dir } });
    // Windows: case-insensitive compare — see the `which` test below.
    expect(out.path.toLowerCase()).toBe(path.toLowerCase());
    expect(out.version).toBe('2.0.0');
  });
});

describe('which', () => {
  it('returns null on empty PATH', () => {
    expect(which('claude', '')).toBeNull();
  });

  it('returns the absolute path when the binary exists in a PATH entry', async () => {
    const path = await makeFakeClaude('ok\n');
    // On Windows, `which` synthesises the path by appending a PATHEXT
    // entry (`.EXE`/`.CMD`/`.BAT` — uppercase by default). The fake we
    // wrote is `claude.cmd` (lowercase). Both resolve to the same file
    // on a case-insensitive filesystem, so compare lowercased.
    const got = which('claude', `${dir}`);
    expect(got?.toLowerCase()).toBe(path.toLowerCase());
  });

  it('returns null when the binary is missing from every PATH entry', () => {
    expect(which('definitely-not-a-real-bin', dir)).toBeNull();
  });
});
