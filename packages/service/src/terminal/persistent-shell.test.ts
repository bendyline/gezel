import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { NodePtyUnavailableError, PersistentShell, loadNodePty } from './persistent-shell.js';

const bashAvailable = process.platform !== 'win32' && existsSync('/bin/bash');
const itPosix = bashAvailable ? it : it.skip;
const itWindows = process.platform === 'win32' ? it : it.skip;

describe('optional node-pty runtime', () => {
  it('wraps an absent or unloadable native addon in a stable terminal error', async () => {
    const cause = new Error('Cannot find package node-pty');
    const importer = vi.fn(async () => Promise.reject(cause));

    await expect(loadNodePty(importer)).rejects.toMatchObject({
      name: 'NodePtyUnavailableError',
      code: 'GEZEL_NODE_PTY_UNAVAILABLE',
      cause,
    });
    await expect(loadNodePty(importer)).rejects.toThrow(/optional node-pty runtime/i);
  });

  it('does not double-wrap an already normalized unavailable error', async () => {
    const unavailable = new NodePtyUnavailableError(new Error('native ABI mismatch'));
    const importer = vi.fn(async () => Promise.reject(unavailable));

    await expect(loadNodePty(importer)).rejects.toBe(unavailable);
  });
});

describe('PersistentShell (POSIX)', () => {
  itPosix('echoes simple command output and captures cwd', async () => {
    const shell = await PersistentShell.start({ cwd: tmpdir() });
    try {
      const res = await shell.run('echo hello-world');
      expect(res.output).toBe('hello-world');
      expect(res.exitCode).toBe(0);
      expect(res.truncated).toBe(false);
      // tmpdir() resolves through different symlink paths on different
      // platforms (/tmp vs /private/tmp on macOS); just check non-empty.
      expect(res.newCwd.length).toBeGreaterThan(0);
    } finally {
      shell.kill();
    }
  });

  itPosix('cd updates newCwd on the same shell', async () => {
    const shell = await PersistentShell.start({ cwd: tmpdir() });
    try {
      const before = (await shell.run('pwd')).newCwd;
      const after = (await shell.run('cd / && pwd')).newCwd;
      expect(after).toBe('/');
      expect(after).not.toBe(before);
    } finally {
      shell.kill();
    }
  });

  itPosix('env vars persist across commands (proves shell is persistent)', async () => {
    const shell = await PersistentShell.start({ cwd: tmpdir() });
    try {
      await shell.run('export GEZEL_TEST_VAR=banana');
      const res = await shell.run('echo $GEZEL_TEST_VAR');
      expect(res.output).toBe('banana');
    } finally {
      shell.kill();
    }
  });

  itPosix('resizes a persistent PTY to the client width before each command', async () => {
    const shell = await PersistentShell.start({ cwd: tmpdir(), columns: 120 });
    try {
      const narrow = await shell.run('stty size', { columns: 72 });
      expect(narrow.output).toBe('50 72');

      const wider = await shell.run('stty size', { columns: 96 });
      expect(wider.output).toBe('50 96');
    } finally {
      shell.kill();
    }
  });

  itPosix('non-zero exit code is captured', async () => {
    const shell = await PersistentShell.start({ cwd: tmpdir() });
    try {
      const res = await shell.run('false');
      expect(res.exitCode).toBe(1);
    } finally {
      shell.kill();
    }
  });

  itPosix("command that prints the literal text 'GEZEL_END' doesn't false-terminate", async () => {
    const shell = await PersistentShell.start({ cwd: tmpdir() });
    try {
      // The sentinel is `__GEZEL_END_<uuid>__`. A user echo of just
      // the prefix shouldn't match — the per-command uuid is the
      // collision guard.
      const res = await shell.run("echo '__GEZEL_END_'");
      expect(res.output).toBe('__GEZEL_END_');
      expect(res.exitCode).toBe(0);
    } finally {
      shell.kill();
    }
  });

  itPosix('per-command timeout kills the shell and rejects the run', async () => {
    const shell = await PersistentShell.start({
      cwd: tmpdir(),
      commandTimeoutMs: 200,
    });
    try {
      await expect(shell.run('sleep 30')).rejects.toThrow(/timed out|killed/i);
      expect(shell.isAlive()).toBe(false);
    } finally {
      shell.kill();
    }
  });

  itPosix('run() rejects after the shell has been killed', async () => {
    const shell = await PersistentShell.start({ cwd: tmpdir() });
    shell.kill();
    // Give the exit handler a tick to flip `exited`.
    await new Promise((r) => setTimeout(r, 50));
    await expect(shell.run('echo hi')).rejects.toThrow(/exited/i);
  });

  itPosix('whenExited() resolves only after the PTY has actually exited', async () => {
    const shell = await PersistentShell.start({ cwd: tmpdir() });
    const exited = shell.whenExited();

    // Before kill the barrier is pending — a short timer wins the race.
    const beforeKill = await Promise.race([
      exited.then(() => 'exited' as const),
      new Promise<'pending'>((r) => setTimeout(() => r('pending'), 50)),
    ]);
    expect(beforeKill).toBe('pending');

    shell.kill();

    // After kill the native onExit fires and resolves the barrier; this
    // await is what shutdown() relies on to let node-pty finish its
    // native teardown before the process exits.
    await exited;
    expect(shell.isAlive()).toBe(false);
    // Idempotent: a second call resolves immediately (already exited).
    await shell.whenExited();
  });

  itPosix('streams output chunks via onChunk before the final result resolves', async () => {
    const shell = await PersistentShell.start({ cwd: tmpdir() });
    try {
      const chunks: string[] = [];
      // Three echoes with sleeps between them — guarantees the
      // PTY delivers data in distinct chunks, not all at once.
      const res = await shell.run('echo c1; sleep 0.1; echo c2; sleep 0.1; echo c3', {
        onChunk: (chunk) => chunks.push(chunk),
      });
      // The final batched output contains all three.
      expect(res.output).toContain('c1');
      expect(res.output).toContain('c2');
      expect(res.output).toContain('c3');
      // At least two chunks should have fired (the test guards
      // against fast machines that might still see all three
      // arrive in one node-pty data event — but two or more is
      // the minimum proof that streaming actually streamed).
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      // None of the chunks should contain our sentinel or printf
      // template — those are echo artifacts we must filter out.
      const joined = chunks.join('');
      expect(joined).not.toContain('__GEZEL_END_');
      expect(joined).not.toContain('printf');
      // Joined chunks should equal the final output (modulo
      // trailing whitespace handled by cleanOutput).
      expect(joined.trim()).toContain('c1');
      expect(joined.trim()).toContain('c3');
    } finally {
      shell.kill();
    }
  });

  itPosix('interrupt() sends Ctrl+C without killing the shell', async () => {
    const shell = await PersistentShell.start({ cwd: tmpdir() });
    try {
      // Start a 30s sleep, then SIGINT it 150ms later. Should
      // resolve with non-zero exit (typically 130 = 128 + SIGINT)
      // and the shell should still be alive afterward.
      const runP = shell.run('sleep 30');
      setTimeout(() => shell.interrupt(), 150);
      const res = await runP;
      expect(res.exitCode).not.toBe(0);
      expect(shell.isAlive()).toBe(true);

      // Prove the shell is still usable by running a fresh
      // command after the interrupt.
      const after = await shell.run('echo still-alive');
      expect(after.output).toBe('still-alive');
      expect(after.exitCode).toBe(0);
    } finally {
      shell.kill();
    }
  });

  itPosix('detects an interactive prompt + feedInput unblocks the command', async () => {
    const shell = await PersistentShell.start({ cwd: tmpdir() });
    try {
      // `read -p "name? " name` blocks waiting for input. Our
      // prompt detector should fire ~600ms after the shell goes
      // quiet on the "name? " line.
      const detected: Array<{ promptLine: string; mode: string }> = [];
      const runP = shell.run('read -p "name? " name && echo "got=$name"', {
        onPromptDetected: (info) => detected.push(info),
      });
      // Wait long enough for prompt detection (600ms idle + a
      // little slack) then send the answer.
      await new Promise((r) => setTimeout(r, 900));
      expect(detected.length).toBeGreaterThanOrEqual(1);
      expect(detected[0]!.mode).toBe('text');
      expect(detected[0]!.promptLine).toMatch(/name\?/i);
      // Feed the response — read picks it up, runs the echo,
      // sentinel fires, run resolves with `got=…` in output.
      expect(shell.feedInput('Mike')).toBe(true);
      const res = await runP;
      expect(res.output).toContain('got=Mike');
      expect(res.exitCode).toBe(0);
    } finally {
      shell.kill();
    }
  });

  itPosix('two concurrent run() calls — second rejects (pool serializes above)', async () => {
    const shell = await PersistentShell.start({ cwd: tmpdir() });
    try {
      const slow = shell.run('sleep 0.3');
      await expect(shell.run('echo hi')).rejects.toThrow(/already running/i);
      await slow;
    } finally {
      shell.kill();
    }
  });
});

describe('PersistentShell (Windows)', () => {
  itWindows(
    'finishes initialization before accepting and streaming the first command',
    async () => {
      const shell = await PersistentShell.start({ cwd: tmpdir(), commandTimeoutMs: 10_000 });
      try {
        const chunks: string[] = [];
        const run = shell.run(
          'Write-Output BUILD-START; Start-Sleep -Milliseconds 700; Write-Output BUILD-END',
          {
            onChunk: (chunk) => chunks.push(chunk),
          },
        );

        // If initialization left a prompt-producing line queued, this run
        // resolves almost immediately and the actual command continues
        // unobserved. It must still be in flight while the simulated build
        // is sleeping.
        const early = await Promise.race([
          run.then(() => 'finished' as const),
          new Promise<'running'>((resolve) => setTimeout(() => resolve('running'), 250)),
        ]);
        expect(early).toBe('running');

        const result = await run;
        const streamed = chunks.join('');
        expect(result.output).toContain('BUILD-START');
        expect(result.output).toContain('BUILD-END');
        expect(streamed).toContain('BUILD-START');
        expect(streamed).toContain('BUILD-END');
        expect(result.output).not.toContain('$null');
        expect(result.output).not.toContain('>>');
        expect(result.newCwd).not.toContain(String.fromCharCode(0x1b));
        expect(result.newCwd).not.toMatch(/\[[0-9;]*m/);
        expect(result.durationMs).toBeGreaterThanOrEqual(600);
      } finally {
        shell.kill();
        await shell.whenExited();
      }
    },
  );
});
