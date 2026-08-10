import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type InstalledToolset, securityPolicyForLevel } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let home: string;
let installPath: string;
let baseUrl: string;
let httpFetch: typeof fetch;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;
const priorSkipFlag = process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP;
const APP_DIR = fileURLToPath(new URL('../../../../app', import.meta.url));
const BROWSER_CACHES = [
  join(homedir(), 'Library/Caches/ms-playwright'),
  join(homedir(), '.cache/ms-playwright'),
];
const realBrowsersPath = BROWSER_CACHES.find((path) => existsSync(path));
const canRunRealBrowser =
  existsSync(join(APP_DIR, 'node_modules', 'playwright')) && realBrowsersPath !== undefined;
const canRunRealTestRunner =
  existsSync(join(APP_DIR, 'node_modules', '.bin', 'playwright')) &&
  existsSync(join(APP_DIR, 'node_modules', 'playwright', 'test.mjs'));

function playwrightToolset(path: string): InstalledToolset {
  return {
    toolsetId: '@playwright/mcp',
    sourceId: 'system',
    version: '0.0.78',
    installedAt: '2026-08-09T00:00:00Z',
    installPath: path,
    runtime: {
      kind: 'npm-package',
      package: '@playwright/mcp',
      version: '0.0.78',
      sha256:
        'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
      entry: 'cli.js',
      args: [],
      envHints: [],
    },
  };
}

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP = '1';

  home = await mkdtemp(join(tmpdir(), 'gezel-run-playwright-route-'));
  if (canRunRealBrowser && realBrowsersPath) {
    await symlink(realBrowsersPath, join(home, 'playwright-browsers'), 'dir');
  }
  installPath = join(home, 'managed-playwright');
  const probePackage = join(installPath, 'node_modules', 'browser-probe-package');
  const nestedDependency = join(probePackage, 'node_modules', 'browser-probe-dependency');
  await mkdir(nestedDependency, { recursive: true });
  await writeFile(
    join(installPath, 'package.json'),
    JSON.stringify({ name: 'managed-playwright-test-root', private: true, type: 'module' }),
  );
  await writeFile(
    join(probePackage, 'package.json'),
    JSON.stringify({
      name: 'browser-probe-package',
      version: '1.0.0',
      type: 'module',
      exports: './index.js',
    }),
  );
  await writeFile(
    join(probePackage, 'index.js'),
    [
      "import { nested } from 'browser-probe-dependency';",
      "export const sentinel = 'resolved-from-managed-toolset/' + nested;",
    ].join('\n'),
  );
  await writeFile(
    join(nestedDependency, 'package.json'),
    JSON.stringify({
      name: 'browser-probe-dependency',
      version: '1.0.0',
      type: 'module',
      exports: './index.js',
    }),
  );
  await writeFile(
    join(nestedDependency, 'index.js'),
    "export const nested = 'package-relative-dependency';\n",
  );

  svc = await startService({ home });
  await svc.context.store.writeConfig({ securityPolicy: securityPolicyForLevel('free') });
  await svc.context.store.writeInstalledToolsets({ kind: 'system' }, [
    playwrightToolset(installPath),
  ]);
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 30_000);

afterAll(async () => {
  await svc?.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
  if (priorSkipFlag === undefined) delete process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP;
  else process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP = priorSkipFlag;
}, 30_000);

async function runPlaywright(
  path: string,
  mode: 'script' | 'test' = 'script',
): Promise<{
  status: number;
  body: { ok: boolean; log: string; error?: string };
}> {
  const res = await httpFetch(`${baseUrl}/api/projects/default/run-playwright`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${svc.context.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ path, mode }),
  });
  return {
    status: res.status,
    body: (await res.json()) as { ok: boolean; log: string; error?: string },
  };
}

describe('POST /api/projects/:id/run-playwright', () => {
  it('resolves bare ESM imports from the managed toolset for an artifact script', async () => {
    await svc.context.store.writeProjectArtifact(
      'default',
      'scripts/import-managed-package.ts',
      [
        "import { sentinel } from 'browser-probe-package';",
        "console.log('probe=' + sentinel);",
      ].join('\n'),
    );

    const result = await runPlaywright('scripts/import-managed-package.ts');

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true });
    expect(result.body.log).toContain(
      'probe=resolved-from-managed-toolset/package-relative-dependency',
    );
  });

  it.runIf(canRunRealBrowser)(
    'launches real Chromium and exercises a page through the artifact route',
    async () => {
      await svc.context.store.writeInstalledToolsets({ kind: 'system' }, [
        playwrightToolset(APP_DIR),
      ]);
      try {
        await svc.context.store.writeProjectArtifact(
          'default',
          'scripts/real-browser.ts',
          [
            "import { chromium } from 'playwright';",
            'const browser = await chromium.launch({ headless: true });',
            'try {',
            '  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });',
            '  await page.setContent(\'<button>Menu</button><p>closed</p><script>document.querySelector("button").onclick=()=>document.querySelector("p").textContent="open"<\\/script>\');',
            "  await page.getByRole('button', { name: 'Menu' }).click();",
            "  console.log(JSON.stringify({ status: await page.locator('p').textContent(), viewport: page.viewportSize() }));",
            '} finally {',
            '  await browser.close();',
            '}',
          ].join('\n'),
        );

        const result = await runPlaywright('scripts/real-browser.ts');

        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ ok: true });
        expect(result.body.log).toContain(
          '{"status":"open","viewport":{"width":375,"height":812}}',
        );
      } finally {
        await svc.context.store.writeInstalledToolsets({ kind: 'system' }, [
          playwrightToolset(installPath),
        ]);
      }
    },
    60_000,
  );

  it.runIf(canRunRealTestRunner)(
    'runs an external artifact spec through the real Playwright test runner',
    async () => {
      const priorNodeOptions = process.env.NODE_OPTIONS;
      process.env.NODE_OPTIONS = priorNodeOptions
        ? `${priorNodeOptions} --no-deprecation`
        : '--no-deprecation';
      await svc.context.store.writeInstalledToolsets({ kind: 'system' }, [
        playwrightToolset(APP_DIR),
      ]);
      await svc.context.store.writeProjectArtifact(
        'default',
        'tests/external-artifact.spec.ts',
        [
          "import { expect, test } from '@playwright/test';",
          "test('external artifact spec', () => {",
          "  expect(process.env.NODE_OPTIONS).toContain('--no-deprecation');",
          '  expect(6 * 7).toBe(42);',
          "  console.log('external-artifact-spec-ran');",
          '});',
        ].join('\n'),
      );

      try {
        const result = await runPlaywright('tests/external-artifact.spec.ts', 'test');

        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ ok: true });
        expect(result.body.log).toContain('external-artifact-spec-ran');
      } finally {
        if (priorNodeOptions === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = priorNodeOptions;
        await svc.context.store.writeInstalledToolsets({ kind: 'system' }, [
          playwrightToolset(installPath),
        ]);
      }
    },
    60_000,
  );

  it('preserves a script failure and its output in the structured result', async () => {
    await svc.context.store.writeProjectArtifact(
      'default',
      'scripts/fails.ts',
      "console.error('intentional-playwright-probe-failure'); process.exit(7);\n",
    );

    const result = await runPlaywright('scripts/fails.ts');

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: false, error: 'exit code 7' });
    expect(result.body.log).toContain('intentional-playwright-probe-failure');
  });

  it('returns an actionable error before spawning when the artifact is missing', async () => {
    const result = await runPlaywright('scripts/does-not-exist.ts');

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: false });
    expect(result.body.error).toContain("doesn't exist");
    expect(result.body.error).toContain('write_artifact');
  });

  it('denies the execution sink when script execution is disabled', async () => {
    await svc.context.store.writeConfig({
      securityPolicy: securityPolicyForLevel('super-lockdown'),
    });
    try {
      const result = await runPlaywright('scripts/import-managed-package.ts');

      expect(result.status).toBe(403);
      expect(result.body).toMatchObject({ ok: false, log: '' });
      expect(result.body.error).toMatch(/script execution is disabled/i);
    } finally {
      await svc.context.store.writeConfig({ securityPolicy: securityPolicyForLevel('free') });
    }
  });
});
