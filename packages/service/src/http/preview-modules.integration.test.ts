import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../service.js';

let svc: RunningService;
let home: string;
let httpFetch: typeof fetch;
let baseUrl: string;

const files: Record<string, string> = {
  'tanks/index.html':
    '<!doctype html><head><script type="module" src="/src/main.ts"></script></head><body><canvas id="board"></canvas></body>',
  'tanks/src/main.ts':
    "import { Engine } from './engine';\nimport type { Missing } from './types';\nimport { units } from './units';\nconst engine: Engine = new Engine(units);\nexport { engine };",
  'tanks/src/engine.ts':
    "import { units } from './units/index.js';\nexport class Engine { constructor(private list: string[]) {} size(): number { return this.list.length + units.length; } }",
  'tanks/src/units/index.ts': "export const units: string[] = ['scout'];",
  'tanks/src/broken.ts': "import { Game } from './game/Game';\nnew Game();",
  'tanks/src/vite.tsx':
    "import { createRoot } from 'react-dom/client';\ncreateRoot(document.body);",
  'tanks/src/typo.ts': 'const x = ;',
};

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-preview-modules-'));
  process.env.GEZEL_MOCK_PROVIDER = '1';
  svc = await startService({ home });
  baseUrl = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  for (const [path, content] of Object.entries(files))
    await svc.context.store.writeProjectWorkspaceFile('default', path, content);
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true });
  delete process.env.GEZEL_MOCK_PROVIDER;
}, 30_000);

async function previewBase(): Promise<string> {
  const minted = await httpFetch(`${baseUrl}/api/projects/default/preview-capability`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${svc.clientToken}` },
    body: JSON.stringify({ source: 'workspace', path: 'tanks/index.html' }),
  });
  const { url } = (await minted.json()) as { url: string };
  return `${baseUrl}${url.slice(0, url.lastIndexOf('/') + 1)}`;
}

describe('TypeScript in a workspace preview', () => {
  it('serves a source module as JavaScript, each import naming its exact file', async () => {
    const base = await previewBase();
    const page = await (await httpFetch(`${base}index.html`)).text();
    expect(page).toContain('<script type="module" src="src/main.ts"');

    const main = await httpFetch(`${base}src/main.ts`);
    expect(main.status).toBe(200);
    expect(main.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(main.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
    const code = await main.text();
    expect(code).toMatch(/from ['"]\.\/engine\.ts['"]/);
    expect(code).toMatch(/from ['"]\.\/units\/index\.ts['"]/);
    // A type-only import of a missing file is not a dependency.
    expect(code).not.toContain('./types');
    expect(code).not.toContain(': Engine');

    const engine = await (await httpFetch(`${base}src/engine.ts`)).text();
    expect(engine).toMatch(/from ['"]\.\/units\/index\.ts['"]/);
  });

  it('sends a script request spelled the way an import is to the file it names', async () => {
    const base = await previewBase();
    const asScript = { headers: { 'sec-fetch-dest': 'script' }, redirect: 'manual' as const };
    const named = await httpFetch(`${base}src/engine`, asScript);
    expect(named.status).toBe(307);
    expect(named.headers.get('location')).toMatch(/\/tanks\/src\/engine\.ts$/);
    const folder = await httpFetch(`${base}src/units`, asScript);
    expect(folder.headers.get('location')).toMatch(/\/tanks\/src\/units\/index\.ts$/);
    // A page request keeps static-host semantics.
    expect((await httpFetch(`${base}src/engine`, { redirect: 'manual' })).status).toBe(404);
  });

  it('shows why a module cannot run instead of a blank page', async () => {
    const base = await previewBase();
    const broken = await (await httpFetch(`${base}src/broken.ts`)).text();
    expect(broken).toContain(
      "tanks/src/broken.ts imports ./game/Game, which isn't in the project.",
    );
    expect(broken).toContain("setAttribute('role','alert')");
    const vite = await (await httpFetch(`${base}src/vite.tsx`)).text();
    expect(vite).toContain('imports the npm package \\"react-dom\\"');
    expect(vite).toContain('preview its generated dist/index.html');
    const typo = await (await httpFetch(`${base}src/typo.ts`)).text();
    expect(typo).toContain('tanks/src/typo.ts:1:11');
  });
});
