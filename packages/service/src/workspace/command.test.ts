import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runWorkspaceCommand } from './command.js';

let dir: string;

beforeEach(async () => {
  dir = join(tmpdir(), `gezel-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('runWorkspaceCommand', () => {
  it('captures stdout + stderr and exit code from a successful run', async () => {
    const script = join(dir, 'echo.mjs');
    await writeFile(
      script,
      `process.stdout.write('hello');process.stderr.write('warn');process.exit(0);`,
    );
    const res = await runWorkspaceCommand({
      bin: process.execPath,
      args: [script],
      cwd: dir,
    });
    expect(res.ok).toBe(true);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('hello');
    expect(res.stderr).toBe('warn');
    expect(res.timedOut).toBe(false);
  });

  it('reports exit codes for failing commands', async () => {
    const script = join(dir, 'fail.mjs');
    await writeFile(script, 'process.exit(7);');
    const res = await runWorkspaceCommand({
      bin: process.execPath,
      args: [script],
      cwd: dir,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(7);
    expect(res.timedOut).toBe(false);
  });

  it('scrubs secrets from the child env', async () => {
    const script = join(dir, 'env.mjs');
    await writeFile(
      script,
      `process.stdout.write(JSON.stringify({ hasToken: 'GEZEL_TOKEN' in process.env, hasKey: 'OPENAI_API_KEY' in process.env, hasPath: 'PATH' in process.env }));`,
    );
    // Plant secrets in the parent env to prove the scrub works.
    const prevToken = process.env.GEZEL_TOKEN;
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.GEZEL_TOKEN = 'tok-should-be-scrubbed';
    process.env.OPENAI_API_KEY = 'sk-should-be-scrubbed';
    try {
      const res = await runWorkspaceCommand({
        bin: process.execPath,
        args: [script],
        cwd: dir,
      });
      expect(res.ok).toBe(true);
      const parsed = JSON.parse(res.stdout);
      expect(parsed.hasToken).toBe(false);
      expect(parsed.hasKey).toBe(false);
      expect(parsed.hasPath).toBe(true);
    } finally {
      if (prevToken === undefined) delete process.env.GEZEL_TOKEN;
      else process.env.GEZEL_TOKEN = prevToken;
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
    }
  });

  it('runs the child in the requested cwd', async () => {
    const script = join(dir, 'cwd.mjs');
    await writeFile(script, 'process.stdout.write(process.cwd());');
    const res = await runWorkspaceCommand({
      bin: process.execPath,
      args: [script],
      cwd: dir,
    });
    expect(res.ok).toBe(true);
    // macOS sometimes prepends `/private` to realpath'd temp dirs;
    // accept either the raw or prefixed form.
    expect(res.stdout === dir || res.stdout === `/private${dir}`).toBe(true);
  });

  it('allows approved package commands to spawn child processes', async () => {
    const script = join(dir, 'spawn-child.mjs');
    await writeFile(
      script,
      [
        "import { execFileSync } from 'node:child_process';",
        "const output = execFileSync(process.execPath, ['-e', 'process.stdout.write(\"child-ok\")']);",
        'process.stdout.write(output);',
      ].join('\n'),
    );

    const res = await runWorkspaceCommand({
      bin: process.execPath,
      args: [script],
      cwd: dir,
    });

    expect(res.ok).toBe(true);
    expect(res.stdout).toBe('child-ok');
  });

  it('keeps network access available to approved package commands', async () => {
    const server = createServer((_req, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('network-ok');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server has no TCP port');
      const script = join(dir, 'network.mjs');
      await writeFile(
        script,
        `const response = await fetch('http://127.0.0.1:${address.port}');process.stdout.write(await response.text());`,
      );

      const res = await runWorkspaceCommand({
        bin: process.execPath,
        args: [script],
        cwd: dir,
      });

      expect(res.ok).toBe(true);
      expect(res.stdout).toBe('network-ok');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
