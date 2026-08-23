import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatEventBus } from '../chat/events.js';
import { ChatManager } from '../chat/manager.js';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ScriptRunner, extractScriptFailureFromStderr } from './runner.js';

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
let mock: MockProvider;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-scripts-test-'));
  store = new Store({ home });
  await store.ensureLayout();
  // This suite injects a mock under the 'copilot' key. Pin it as the default
  // too — otherwise routing falls through to the platform default (an
  // on-device engine) and the injected mock is never reached.
  await store.writeConfig({ provider: 'copilot' });
  await store.createProject({ name: 'Default' });
  mock = new MockProvider({ name: 'copilot' });
  manager = new ChatManager({
    store,
    events: new ChatEventBus(),
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [['copilot', mock]],
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

describe('extractScriptFailureFromStderr', () => {
  it('preserves an ordinary thrown error while dropping its stack', () => {
    const stderr = [
      'Error: Illegal move f6-e5. Legal moves for black: d8-e7, f8-e7, b6-c5',
      '    at file:///tmp/game-store.ts:42:11',
      '    at async ModuleJob.run (node:internal/modules/esm/module_job:271:25)',
    ].join('\n');

    expect(extractScriptFailureFromStderr(stderr)).toBe(
      'Error: Illegal move f6-e5. Legal moves for black: d8-e7, f8-e7, b6-c5',
    );
  });

  it('keeps sandbox refusals ahead of incidental exceptions', () => {
    const stderr = [
      'TypeError: wrapper failed',
      '[sandbox error] denyNet requires an enforceable OS network boundary',
    ].join('\n');

    expect(extractScriptFailureFromStderr(stderr)).toBe(
      '[sandbox error] denyNet requires an enforceable OS network boundary',
    );
  });
});

it.runIf(process.platform !== 'darwin')(
  'fails closed with an actionable error when denyNet has no OS boundary',
  async () => {
    await writeScript(
      'no-boundary',
      `
        import { gezel, defineScript } from '@bendyline/gezel-sdk';
        export const meta = defineScript({ name: 'no-boundary', description: 'must not run' });
        gezel.output({ ran: true });
      `,
    );
    const run = await runner.run({
      projectId: 'default',
      scriptName: 'no-boundary',
      trigger: { kind: 'manual', userInitiated: true },
    });
    expect(run.status).toBe('error');
    // The sandbox's own refusal line is surfaced as the run error (not the
    // bare exit code) — it is the caller's only repair signal.
    expect(run.error).toContain('denyNet requires an enforceable OS network boundary');
    expect(run.logs).toContain('denyNet requires an enforceable OS network boundary');
  },
  30_000,
);

// Provenance-trusted lane: a project script whose bytes exactly match the
// catalog-shipped project-type script runs even where denyNet has no OS
// boundary (Windows; Linux under the RPC channel). Any tampering — one
// appended byte — drops it back to the fail-closed path. Uses the real
// bundled fitness-coach type so a break in the shipped bytes fails here.
describe('ScriptRunner — provenance-trusted sandbox lane', () => {
  const header = '// @gezel-project-type: fitness-coach@1.0.0\n';

  async function installShippedScript(catalog: CatalogService, tamper = false): Promise<void> {
    const detail = await catalog.get('project-type', 'fitness-coach');
    if (!detail || detail.manifest.kind !== 'project-type') throw new Error('type missing');
    const body = (detail.manifest.scripts as Record<string, string>)['training-store']!;
    await writeScript('training-store', `${header}${body}${tamper ? '\n// tampered\n' : ''}`);
  }

  it('executes a byte-verified project-type script on every platform', async () => {
    const catalog = new CatalogService();
    const trustedRunner = new ScriptRunner({ store, chat: manager, catalog });
    await installShippedScript(catalog);
    const run = await trustedRunner.run({
      projectId: 'default',
      scriptName: 'training-store',
      inputs: { action: 'status' },
      trigger: { kind: 'manual', userInitiated: true },
    });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe('ok');
    expect(run.output).toMatchObject({ streakDays: 0, thisWeek: 0 });
    expect(String((run.output as { summary?: unknown }).summary)).toContain(
      'No sessions logged yet',
    );
  }, 60_000);

  it.runIf(process.platform !== 'darwin')(
    'a tampered copy of the shipped script fails closed again',
    async () => {
      const catalog = new CatalogService();
      const trustedRunner = new ScriptRunner({ store, chat: manager, catalog });
      await installShippedScript(catalog, true);
      const run = await trustedRunner.run({
        projectId: 'default',
        scriptName: 'training-store',
        inputs: { action: 'status' },
        trigger: { kind: 'manual', userInitiated: true },
      });
      expect(run.status).toBe('error');
      expect(run.error).toContain('denyNet requires an enforceable OS network boundary');
    },
    30_000,
  );

  it.runIf(process.platform !== 'darwin')(
    'without a catalog the same bytes stay fail-closed',
    async () => {
      const catalog = new CatalogService();
      await installShippedScript(catalog);
      const run = await runner.run({
        projectId: 'default',
        scriptName: 'training-store',
        inputs: { action: 'status' },
        trigger: { kind: 'manual', userInitiated: true },
      });
      expect(run.status).toBe('error');
      expect(run.error).toContain('denyNet requires an enforceable OS network boundary');
    },
    30_000,
  );
});

// Successful denyNet execution is currently supported only by macOS
// Seatbelt. Do not weaken production confinement merely to exercise these
// end-to-end semantics on Windows/Linux.
describe.runIf(process.platform === 'darwin')('ScriptRunner — end-to-end', () => {
  it('runs a trivial script and stamps its output', async () => {
    await writeScript(
      'noop',
      `
        import { gezel, defineScript } from '@bendyline/gezel-sdk';
        export const meta = defineScript({
          name: 'noop',
          description: 'writes a trivial output.',
          outputs: { ok: { type: 'boolean', description: 'success' } },
        });
        gezel.output({ ok: true });
      `,
    );
    const run = await runner.run({
      projectId: 'default',
      scriptName: 'noop',
      trigger: { kind: 'manual', userInitiated: true },
    });
    expect(run.status).toBe('ok');
    expect(run.output).toEqual({ ok: true });
  });

  it('validates inputs against meta.inputs before spawning', async () => {
    await writeScript(
      'need-base',
      `
        import { gezel, defineScript } from '@bendyline/gezel-sdk';
        export const meta = defineScript({
          name: 'need-base',
          description: 'requires a base currency input.',
          inputs: {
            base: { type: 'string', description: 'iso code', required: true, pattern: '^[A-Z]{3}$' },
          },
          outputs: { echoed: { type: 'string', description: 'echo' } },
        });
        gezel.output({ echoed: (gezel.input as { base: string }).base });
      `,
    );

    // Valid input round-trips.
    const ok = await runner.run({
      projectId: 'default',
      scriptName: 'need-base',
      inputs: { base: 'USD' },
      trigger: { kind: 'manual', userInitiated: true },
    });
    expect(ok.status).toBe('ok');
    expect(ok.output).toEqual({ echoed: 'USD' });

    // Missing required input fails *before* the sandbox spawns.
    await expect(
      runner.run({
        projectId: 'default',
        scriptName: 'need-base',
        trigger: { kind: 'manual', userInitiated: true },
      }),
    ).rejects.toThrow(/required/);

    // Pattern mismatch fails the same way.
    await expect(
      runner.run({
        projectId: 'default',
        scriptName: 'need-base',
        inputs: { base: 'usd' },
        trigger: { kind: 'manual', userInitiated: true },
      }),
    ).rejects.toThrow(/pattern/);
  });

  it('enforces meta.requires — undeclared capabilities are rejected at call time', async () => {
    await writeScript(
      'undeclared-artifact',
      `
        import { gezel, defineScript } from '@bendyline/gezel-sdk';
        export const meta = defineScript({
          name: 'undeclared-artifact',
          description: 'tries to write an artifact without declaring it.',
          outputs: { caught: { type: 'boolean', description: 'caught flag' } },
        });
        let caught = false;
        try {
          await gezel.artifacts.write('x.txt', 'hi');
        } catch (e) {
          caught = true;
        }
        gezel.output({ caught });
      `,
    );
    const run = await runner.run({
      projectId: 'default',
      scriptName: 'undeclared-artifact',
      trigger: { kind: 'manual', userInitiated: true },
    });
    expect(run.status).toBe('ok');
    expect(run.output).toEqual({ caught: true });
    // The denied call should be on the trace with the error.
    const deniedCall = run.calls.find((c) => c.kind === 'artifact.write');
    expect(deniedCall?.error).toMatch(/CAPABILITY_DENIED|did not declare|capability/i);
  });

  it('routes declared SDK calls through the dispatcher', async () => {
    await writeScript(
      'writes-artifact',
      `
        import { gezel, defineScript } from '@bendyline/gezel-sdk';
        export const meta = defineScript({
          name: 'writes-artifact',
          description: 'writes an artifact with the proper capability.',
          requires: ['artifacts.write'],
          outputs: { path: { type: 'string', description: 'written path' } },
        });
        await gezel.artifacts.write('greeting.txt', 'hello');
        gezel.output({ path: 'greeting.txt' });
      `,
    );
    const run = await runner.run({
      projectId: 'default',
      scriptName: 'writes-artifact',
      trigger: { kind: 'manual', userInitiated: true },
    });
    expect(run.status).toBe('ok');
    expect(run.output).toEqual({ path: 'greeting.txt' });
    // Artifact was really written.
    const written = await store.readProjectArtifact('default', 'greeting.txt');
    expect(written).toBe('hello');
  });

  it('validates output against meta.outputs', async () => {
    await writeScript(
      'bad-output',
      `
        import { gezel, defineScript } from '@bendyline/gezel-sdk';
        export const meta = defineScript({
          name: 'bad-output',
          description: 'stamps an output that does not match its declared type.',
          outputs: { count: { type: 'number', description: 'how many' } },
        });
        gezel.output({ count: 'three' });
      `,
    );
    const run = await runner.run({
      projectId: 'default',
      scriptName: 'bad-output',
      trigger: { kind: 'manual', userInitiated: true },
    });
    expect(run.status).toBe('error');
    expect(run.error).toMatch(/count.*number.*string/);
  });
});

describe('ScriptRunner — inline sources', () => {
  const source = `
    import { gezel, defineScript } from '@bendyline/gezel-sdk';
    export const meta = defineScript({
      name: 'inlineNoop',
      description: 'inline-source script that stamps a trivial output.',
      outputs: { ok: { type: 'boolean', description: 'success' } },
    });
    gezel.output({ ok: true });
  `;

  it.runIf(process.platform === 'darwin')(
    'executes an inline source without any on-disk script file',
    async () => {
      const run = await runner.run({
        projectId: 'default',
        scriptName: 'inlineNoop',
        scope: 'craftbook',
        inlineSource: source,
        trigger: { kind: 'manual', userInitiated: true },
      });
      expect(run.status).toBe('ok');
      expect(run.output).toEqual({ ok: true });
    },
    60_000,
  );

  it('refuses inlineSource at standard scope', async () => {
    await expect(
      runner.run({
        projectId: 'default',
        scriptName: 'inlineNoop',
        scope: 'standard',
        inlineSource: source,
        trigger: { kind: 'manual', userInitiated: true },
      }),
    ).rejects.toThrow(/standard scope/);
  });
});

// The index-readiness ensure, end to end: the REAL stdlib `ensureIndexFresh`
// runs in a real sandbox, reaches `gezel.index.ensureFresh` over fd-3 RPC
// through the late-bound index access (the same setIndexAccess seam
// service.ts wires), and lands the readiness report in the artifacts drawer
// where the consuming craftbook step reads it.
describe.runIf(process.platform === 'darwin')('stdlib ensureIndexFresh — end-to-end', () => {
  it('publishes the readiness report artifact through the sandbox', async () => {
    const report = {
      version: 1,
      projectId: 'default',
      generatedAt: '2026-08-23T12:00:00Z',
      indexingEnabled: true,
      staticState: 'fresh',
      search: { ready: true },
      aiTier: { staffed: false, paused: false, achievable: false },
      wait: { budgetMs: 60_000, waitedMs: 5, drained: true, driveStillRunning: false },
      notes: ['No Boekwachter gezel is on this project crew.'],
    };
    const seen: unknown[] = [];
    runner.setIndexAccess({
      status: async () => ({ state: 'fresh' }),
      ensureFresh: async (projectId, opts) => {
        seen.push({ projectId, opts });
        return report as never;
      },
    });
    const run = await runner.run({
      projectId: 'default',
      scriptName: 'ensureIndexFresh',
      scope: 'standard',
      inputs: { outFile: 'tasks/9/review/index-readiness.json', waitBudgetSeconds: 60 },
      trigger: { kind: 'manual', userInitiated: true },
    });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe('ok');
    expect(run.output).toMatchObject({
      ok: true,
      outFile: 'tasks/9/review/index-readiness.json',
      staticState: 'fresh',
      drained: true,
      aiAchievable: false,
      notes: 1,
    });
    expect(seen).toEqual([{ projectId: 'default', opts: { waitBudgetMs: 60_000 } }]);
    const artifact = await store.readProjectArtifact(
      'default',
      'tasks/9/review/index-readiness.json',
    );
    expect(artifact).not.toBeNull();
    expect(JSON.parse(artifact!)).toMatchObject({ version: 1, staticState: 'fresh' });
  }, 60_000);
});
