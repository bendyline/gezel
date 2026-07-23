import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexBinaryNotFoundError, resolveCodexBinary, which } from './binary.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-codex-cli-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function makeFakeCodex(stdout: string, exitCode = 0): Promise<string> {
  if (process.platform === 'win32') {
    // Windows: write a .cmd shim so the loader can exec it AND `which`
    // (which iterates PATHEXT extensions) can find it. Mirrors the
    // makeFakeClaude shape in anthropic-cli/binary.test.ts.
    const path = join(dir, 'codex.cmd');
    const escaped = stdout.replace(/[\r\n]+$/, '').replaceAll('%', '%%');
    const script = `@echo off\r\n<NUL set /p =${escaped}\r\necho.\r\nexit /b ${exitCode}\r\n`;
    await writeFile(path, script, 'utf8');
    return path;
  }
  const path = join(dir, 'codex');
  const script = `#!/bin/sh\nprintf '%s' '${stdout.replaceAll("'", "'\\''")}'\nexit ${exitCode}\n`;
  await writeFile(path, script, 'utf8');
  await chmod(path, 0o755);
  return path;
}

describe('resolveCodexBinary', () => {
  it('returns the override when its --version probe succeeds', async () => {
    const path = await makeFakeCodex('codex 0.125.0\n');
    const out = await resolveCodexBinary({ override: path });
    // Case-insensitive on Windows — the .cmd / .CMD distinction comes
    // from PATHEXT iteration in `which`. See the `which` test below.
    expect(out.path.toLowerCase()).toBe(path.toLowerCase());
    expect(out.version).toBe('codex 0.125.0');
  });

  it('throws an actionable error when nothing on PATH and no override', async () => {
    await expect(resolveCodexBinary({ env: { PATH: dir } })).rejects.toBeInstanceOf(
      CodexBinaryNotFoundError,
    );
  });

  it('throws an actionable error when the override exists but exits non-zero', async () => {
    const path = await makeFakeCodex('boom', 9);
    await expect(resolveCodexBinary({ override: path })).rejects.toBeInstanceOf(
      CodexBinaryNotFoundError,
    );
  });

  it('finds a binary on PATH when no override is set', async () => {
    const path = await makeFakeCodex('codex 0.126.0\n');
    const out = await resolveCodexBinary({ env: { PATH: dir } });
    expect(out.path.toLowerCase()).toBe(path.toLowerCase());
    expect(out.version).toBe('codex 0.126.0');
  });
});

describe('which', () => {
  it('returns null on empty PATH', () => {
    expect(which('codex', '')).toBeNull();
  });

  it('returns the absolute path when the binary exists in a PATH entry', async () => {
    const path = await makeFakeCodex('ok\n');
    // On Windows, `which` synthesises the path by appending a PATHEXT
    // entry (`.EXE`/`.CMD`/`.BAT` — uppercase by default). The fake we
    // wrote is `codex.cmd` (lowercase). Both resolve to the same file
    // on a case-insensitive filesystem, so compare lowercased.
    const got = which('codex', `${dir}`);
    expect(got?.toLowerCase()).toBe(path.toLowerCase());
  });

  it('returns null when the binary is missing from every PATH entry', () => {
    expect(which('definitely-not-a-real-bin', dir)).toBeNull();
  });
});
