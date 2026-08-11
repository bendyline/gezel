import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let baseUrl: string;
let httpFetch: typeof fetch;
let home: string;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-install-security-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

function install(pathProjectId: string, body: unknown): Promise<Response> {
  return httpFetch(`${baseUrl}/api/projects/${pathProjectId}/install`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${svc.context.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/projects/:id/install security boundary', () => {
  it.each(['%2e%2e%5coutside', '..%2foutside'])(
    'rejects the decoded traversal-shaped project id %s',
    async (projectId) => {
      const response = await install(projectId, { name: 'zod', version: '^4' });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'invalid_entity_id' });
      expect(existsSync(join(home, 'outside', 'package.json'))).toBe(false);
      expect(existsSync(join(home, 'outside', 'node_modules'))).toBe(false);
    },
  );

  it('requires the project to exist before invoking the installer', async () => {
    const response = await install('missing-project', { name: 'zod', version: '^4' });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'project not found' });
    expect(existsSync(join(home, 'projects', 'missing-project'))).toBe(false);
  });

  it.each([
    { name: '--global' },
    { name: 'https://example.test/pkg.tgz' },
    { name: 'git+https://example.test/repo.git' },
    { name: 'file:../outside' },
    { name: 'zod', version: '--config=evil' },
    { name: 'zod', version: 'https://example.test/pkg.tgz' },
    { name: 'zod', version: 'workspace:*' },
  ])('rejects non-registry or option-like package input: $name@$version', async (body) => {
    const response = await install('default', body);

    expect(response.status).toBe(422);
  });
});
