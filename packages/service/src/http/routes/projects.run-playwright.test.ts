import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CommandApprovalIntent,
  type InstalledToolset,
  type Question,
  securityPolicyForLevel,
} from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';
import { applyCommandApprovalAnswer } from '../../workspace/command-approval-answer.js';

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

interface RunPlaywrightBody {
  ok: boolean;
  log: string;
  error?: string;
  approvalPending?: boolean;
  questionId?: string;
  declined?: string;
}

async function runPlaywright(
  path: string,
  mode: 'script' | 'test' = 'script',
  actor: { gezelId?: string; sessionId?: string } = {},
): Promise<{
  status: number;
  body: RunPlaywrightBody;
}> {
  const res = await httpFetch(`${baseUrl}/api/projects/default/run-playwright`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${svc.context.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ path, mode, ...actor }),
  });
  return {
    status: res.status,
    body: (await res.json()) as RunPlaywrightBody,
  };
}

const GEZEL_ACTOR = { gezelId: 'playwright-probe-gezel', sessionId: 'playwright-probe-session' };

async function approvalQuestion(questionId: string): Promise<Question> {
  const questions = await svc.context.store.listProjectQuestions('default');
  const question = questions.find((q) => q.id === questionId);
  if (!question) throw new Error(`question ${questionId} not found`);
  return question;
}

async function answerApproval(questionId: string, choice: 0 | 1): Promise<void> {
  const question = await approvalQuestion(questionId);
  await applyCommandApprovalAnswer({
    home,
    projectId: 'default',
    intent: question.intent as CommandApprovalIntent,
    answer: { selectedChoices: [choice], at: new Date().toISOString() },
  });
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

  it('asks the user before a gezel-initiated run and binds the approval to the script and its imports', async () => {
    await svc.context.store.writeProjectArtifact(
      'default',
      'scripts/gated-helper.ts',
      "export const greeting = 'gated-helper-v1';\n",
    );
    await svc.context.store.writeProjectArtifact(
      'default',
      'scripts/gated.ts',
      "import { greeting } from './gated-helper.ts';\nconsole.log('gated-ran ' + greeting);\n",
    );

    const first = await runPlaywright('scripts/gated.ts', 'script', GEZEL_ACTOR);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: false, approvalPending: true });
    expect(first.body.log).not.toContain('gated-ran');
    const questionId = first.body.questionId!;
    const question = await approvalQuestion(questionId);
    expect(question.sessionId).toBe(GEZEL_ACTOR.sessionId);
    expect(question.intent).toMatchObject({
      kind: 'command-approval',
      scope: 'playwright',
      name: 'scripts/gated.ts',
    });
    expect(question.prompt).toContain("console.log('gated-ran ' + greeting);");
    expect(question.prompt).toContain('scripts/gated-helper.ts');
    expect(question.prompt).toMatch(/not isolated from your OS account/);

    const again = await runPlaywright('scripts/gated.ts', 'script', GEZEL_ACTOR);
    expect(again.body).toMatchObject({ approvalPending: true, questionId });

    await answerApproval(questionId, 0);
    const approved = await runPlaywright('scripts/gated.ts', 'script', GEZEL_ACTOR);
    expect(approved.body).toMatchObject({ ok: true });
    expect(approved.body.log).toContain('gated-ran gated-helper-v1');

    await svc.context.store.writeProjectArtifact(
      'default',
      'scripts/gated-helper.ts',
      "export const greeting = 'gated-helper-v2';\n",
    );
    const edited = await runPlaywright('scripts/gated.ts', 'script', GEZEL_ACTOR);
    expect(edited.body).toMatchObject({ ok: false, approvalPending: true });
    expect(edited.body.questionId).not.toBe(questionId);
    expect(edited.body.log).not.toContain('gated-helper-v2');
  });

  it('refuses a gezel-initiated run the user declined', async () => {
    await svc.context.store.writeProjectArtifact(
      'default',
      'scripts/declined.ts',
      "console.log('declined-script-ran');\n",
    );
    const first = await runPlaywright('scripts/declined.ts', 'script', GEZEL_ACTOR);
    await answerApproval(first.body.questionId!, 1);

    const result = await runPlaywright('scripts/declined.ts', 'script', GEZEL_ACTOR);
    expect(result.body.ok).toBe(false);
    expect(result.body.declined).toMatch(/previously declined/);
    expect(result.body.log).not.toContain('declined-script-ran');
  });

  it('runs the script without the daemon credentials in its environment', async () => {
    const prior = {
      GEZEL_TOKEN: process.env.GEZEL_TOKEN,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN,
    };
    process.env.GEZEL_TOKEN = 'daemon-token-must-not-leak';
    process.env.OPENAI_API_KEY = 'sk-must-not-leak';
    process.env.NODE_AUTH_TOKEN = 'npm-token-must-not-leak';
    await svc.context.store.writeProjectArtifact(
      'default',
      'scripts/env-probe.ts',
      [
        "const keys = ['GEZEL_TOKEN', 'OPENAI_API_KEY', 'NODE_AUTH_TOKEN', 'PATH'];",
        "console.log('env-probe=' + JSON.stringify(Object.fromEntries(keys.map((k) => [k, k in process.env]))));",
      ].join('\n'),
    );
    try {
      const result = await runPlaywright('scripts/env-probe.ts');
      expect(result.body).toMatchObject({ ok: true });
      expect(result.body.log).toContain(
        'env-probe={"GEZEL_TOKEN":false,"OPENAI_API_KEY":false,"NODE_AUTH_TOKEN":false,"PATH":true}',
      );
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('denies the sink under lockdown, where scripts run but the open web is off', async () => {
    await svc.context.store.writeConfig({ securityPolicy: securityPolicyForLevel('lockdown') });
    try {
      const result = await runPlaywright('scripts/import-managed-package.ts');

      expect(result.status).toBe(403);
      expect(result.body).toMatchObject({ ok: false, log: '' });
      expect(result.body.error).toMatch(/external services are disabled/i);
    } finally {
      await svc.context.store.writeConfig({ securityPolicy: securityPolicyForLevel('free') });
    }
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
