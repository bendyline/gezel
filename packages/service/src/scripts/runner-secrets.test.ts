import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { securityPolicyForLevel } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatEventBus } from '../chat/events.js';
import { ChatManager } from '../chat/manager.js';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ScriptRunner } from './runner.js';

/**
 * Slice A regressions — the "scripts never hold secrets" property and
 * the runner's redaction pass over AI-visible run fields.
 */

const noopMemory = {
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

let home: string;
let store: Store;
let manager: ChatManager;
let runner: ScriptRunner;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-runner-secrets-'));
  store = new Store({ home });
  await store.ensureLayout();
  // This suite injects a mock under the 'copilot' key. Pin it as the default
  // too — otherwise routing falls through to the platform default (an
  // on-device engine) and the injected mock is never reached.
  await store.writeConfig({ provider: 'copilot' });
  await store.writeConfig({ securityPolicy: securityPolicyForLevel('free') });
  await store.createProject({ name: 'Default' });
  manager = new ChatManager({
    store,
    events: new ChatEventBus(),
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [['copilot', new MockProvider({ name: 'copilot' })]],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
  runner = new ScriptRunner({ store, chat: manager });
});

afterEach(async () => {
  await manager.drainBackground();
  await manager.shutdown();
  await rm(home, { recursive: true, force: true });
});

async function writeScript(name: string, source: string): Promise<void> {
  const dir = join(home, 'projects', 'default', 'scripts');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.ts`), source, 'utf8');
}

// These regressions require an executing denyNet child. Today only macOS
// Seatbelt provides the OS boundary required to start one.
describe.runIf(process.platform === 'darwin')('ScriptRunner — secret-isolation regressions', () => {
  it('sandbox env contains no SecretStore values (env scrub)', async () => {
    // Plant a recognizable sentinel in every SecretStore kind and
    // confirm none of those values appear anywhere in a run's env,
    // logs, or stdout.
    const secrets = new FileSecretStore(home);
    await secrets.set(
      { kind: 'providerCredential', name: 'githubToken' },
      'sentinel-gh-token-ABC123',
    );
    await secrets.set(
      { kind: 'providerCredential', name: 'openaiApiKey' },
      'sentinel-oa-key-DEF456',
    );
    await secrets.set(
      { kind: 'providerCredential', name: 'openaiOrganization' },
      'sentinel-oa-org-GHI789',
    );
    await secrets.set(
      { kind: 'providerCredential', name: 'webhookBearerToken' },
      'sentinel-wh-bearer-JKL012',
    );
    await secrets.set(
      { kind: 'toolset', toolsetId: 'demo', fieldId: 'token' },
      'sentinel-ts-demo-MNO345',
    );

    await writeScript(
      'env-dump',
      `
        import { gezel, defineScript } from '@bendyline/gezel-sdk';
        export const meta = defineScript({
          name: 'env-dump',
          description: 'dumps every env var so we can assert no secret leaked.',
        });
        const envJson = JSON.stringify(process.env);
        console.log('ENV:' + envJson);
        process.stdout.write('STDOUT:' + envJson + '\\n');
      `,
    );

    const run = await runner.run({
      projectId: 'default',
      scriptName: 'env-dump',
      trigger: { kind: 'manual', userInitiated: true },
    });

    expect(run.status).toBe('ok');
    const corpus = `${run.logs}${JSON.stringify(run.calls)}${JSON.stringify(run.output ?? '')}`;
    const sentinels = [
      'sentinel-gh-token-ABC123',
      'sentinel-oa-key-DEF456',
      'sentinel-oa-org-GHI789',
      'sentinel-wh-bearer-JKL012',
      'sentinel-ts-demo-MNO345',
    ];
    for (const s of sentinels) {
      expect(corpus).not.toContain(s);
    }
  });

  it('redacts a known secret value that shows up in a script output', async () => {
    // Simulate what will happen in Slice C: a dispatcher handler
    // resolves a credential and adds it to `ctx.knownSecretValues`.
    // Since the dispatcher isn't extended yet, we verify the runner
    // scrubs the output field correctly when a secret IS known. We
    // reach into the dispatcher via a one-shot handler that registers
    // a secret before the script's `gezel.output` arrives.
    //
    // The path we exercise: a script calls `gezel.mcp.call('plant',
    // {})` (stubbed to populate knownSecretValues), then stamps an
    // output containing the planted value, then the runner's final
    // redaction pass strips it.

    const planted = 'sentinel-runtime-PQR678';
    // Inject a custom MCP-call forwarder that plants a known secret
    // value on the first call.
    runner.setMcpCall(async (ctx, _tool, _args) => {
      ctx.knownSecretValues.add(planted);
      return { ok: true };
    });

    await writeScript(
      'leak-by-accident',
      `
        import { gezel, defineScript } from '@bendyline/gezel-sdk';
        export const meta = defineScript({
          name: 'leak-by-accident',
          description: 'plants a secret then accidentally echoes it.',
          requires: ['network'],
          outputs: { body: { type: 'string', description: 'accidental echo' } },
        });
        await gezel.mcp.call('plant', {});
        gezel.output({ body: 'the secret was sentinel-runtime-PQR678 oh no' });
      `,
    );

    const run = await runner.run({
      projectId: 'default',
      scriptName: 'leak-by-accident',
      trigger: { kind: 'manual', userInitiated: true },
    });

    expect(run.status).toBe('ok');
    const output = run.output as { body: string };
    expect(output.body).not.toContain(planted);
    expect(output.body).toContain('[REDACTED]');
  });

  it('redacts known secrets from call trace summaries', async () => {
    const planted = 'sentinel-call-STU901';
    runner.setMcpCall(async (ctx, _tool, _args) => {
      ctx.knownSecretValues.add(planted);
      // Return a value that will show up in the call's outputSummary.
      return { echo: `value: ${planted}` };
    });

    await writeScript(
      'echo-leak',
      `
        import { gezel, defineScript } from '@bendyline/gezel-sdk';
        export const meta = defineScript({
          name: 'echo-leak',
          description: 'calls a tool that echoes the planted secret.',
          requires: ['network'],
        });
        const r = await gezel.mcp.call('plant', {});
        gezel.log('got:', r);
      `,
    );

    const run = await runner.run({
      projectId: 'default',
      scriptName: 'echo-leak',
      trigger: { kind: 'manual', userInitiated: true },
    });

    expect(run.status).toBe('ok');
    // The mcp.call trace entry's outputSummary must not contain the secret.
    const mcpCall = run.calls.find((c) => c.kind === 'mcp.call');
    expect(mcpCall).toBeDefined();
    expect(mcpCall?.outputSummary ?? '').not.toContain(planted);
    // Nor should the logs.
    expect(run.logs).not.toContain(planted);
  });

  it('persists the redacted ScriptRun to disk', async () => {
    const planted = 'sentinel-disk-VWX234';
    runner.setMcpCall(async (ctx, _tool, _args) => {
      ctx.knownSecretValues.add(planted);
      return { note: planted };
    });

    await writeScript(
      'disk-leak',
      `
        import { gezel, defineScript } from '@bendyline/gezel-sdk';
        export const meta = defineScript({
          name: 'disk-leak',
          description: 'round-trips a secret into the persisted trace.',
          requires: ['network'],
          outputs: { whispered: { type: 'string', description: 'echo' } },
        });
        const r = await gezel.mcp.call('plant', {}) as { note: string };
        gezel.output({ whispered: r.note });
      `,
    );

    const run = await runner.run({
      projectId: 'default',
      scriptName: 'disk-leak',
      trigger: { kind: 'manual', userInitiated: true },
    });
    expect(run.status).toBe('ok');

    // Re-read from disk and assert nothing on disk holds the value.
    const date = run.startedAt.slice(0, 10);
    const runFile = join(home, 'projects', 'default', 'scripts', 'runs', date, `${run.id}.json`);
    const raw = await (await import('node:fs/promises')).readFile(runFile, 'utf8');
    expect(raw).not.toContain(planted);
  });
});
