/**
 * Exercise the built CLI against a fixture daemon that advertises HTTP/2 and
 * HTTP/1.1. Its isolated runtime files let the real owner discovery and SDK
 * authorization paths run without starting a service or contacting a model.
 */
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createSecureServer } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it.each([
  [false, '2.0'],
  [true, '1.1'],
] as const)(
  'uses HTTP %s/%s through discovery, authorization, and command requests',
  async (http1, version) => {
    const fixture = (name: string) =>
      readFile(new URL(`../../client/src/test-fixtures/tls/${name}.pem`, import.meta.url), 'utf8');
    const [cert, key] = await Promise.all([fixture('server'), fixture('server-key')]);
    const home = await mkdtemp(join(tmpdir(), 'gezel-cli-http1-'));
    const requests: Array<{
      path: string;
      version: string;
      method?: string;
      authorization?: string;
    }> = [];
    let taskReads = 0;
    const server = createSecureServer({ cert, key, allowHTTP1: true }, (req, response) => {
      requests.push({
        path: req.url!,
        method: req.method,
        version: req.httpVersion,
        authorization: req.headers.authorization,
      });
      if (req.url === '/api/projects/test/tasks/1') {
        taskReads++;
        if (taskReads === 1) {
          req.socket.destroy();
          return;
        }
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            ref: 'test/1',
            projectId: 'test',
            num: 1,
            status: 'complete',
            craftbook: {},
          }),
        );
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify(
          req.url === '/api/health'
            ? { ok: true, version: 'test' }
            : req.url === '/api/gezels'
              ? { gezels: [] }
              : {},
        ),
      );
    });
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const runtime = join(home, 'runtime');
      await mkdir(runtime);
      await Promise.all(
        Object.entries({
          pid: String(process.pid),
          port: String((server.address() as AddressInfo).port),
          'auth-token': 'fixture-owner-token',
          'cert.pem': cert,
        }).map(([file, value]) => writeFile(join(runtime, file), value)),
      );
      const env: NodeJS.ProcessEnv = { ...process.env, GEZEL_HOME: home };
      delete env.GEZEL_HTTP_VERSION;
      const entry = fileURLToPath(new URL('../dist/bin/gezel.js', import.meta.url));
      await promisify(execFile)(
        process.execPath,
        [entry, ...(http1 ? ['--http1'] : []), '--home', home, 'agent', 'list'],
        {
          cwd: home,
          env,
          timeout: 15_000,
        },
      );
      if (http1) {
        const result = await promisify(execFile)(
          process.execPath,
          [entry, '--http1', '--home', home, 'task', 'wait', 'test/1', '--timeout', '5', '--json'],
          { cwd: home, env, timeout: 10_000 },
        );
        expect(JSON.parse(result.stdout).outcome).toBe('complete');
        expect(taskReads).toBe(2);
        expect(requests.every((request) => request.method === 'GET')).toBe(true);
      }
      expect(requests.some((req) => req.path === '/api/health')).toBe(true);
      expect(requests.some((req) => req.path === '/api/config')).toBe(true);
      expect(requests.some((req) => req.path === '/api/gezels')).toBe(true);
      expect(new Set(requests.map((req) => req.version))).toEqual(new Set([version]));
      expect(requests.find((req) => req.path === '/api/gezels')?.authorization).toBe(
        'Bearer fixture-owner-token',
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(home, { recursive: true, force: true });
    }
  },
  20_000,
);
