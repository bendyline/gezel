import { GezelConfigSchema, type ScriptMeta, type ScriptRun } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import type { ScriptExecutionOptions, ScriptExecutionResult } from './index.js';
import { PortableScriptRunner, type PortableScriptRunnerOptions } from './runner.js';

/** The host port: what a Node adapter needs beyond what a phone needs. */
const meta: ScriptMeta = {
  name: 'example',
  description: 'Port contract test',
  requires: ['workspace.read', 'artifacts.write'],
};
const request = {
  scope: 'project' as const,
  projectId: 'default',
  scriptName: 'example',
  trigger: { kind: 'manual' as const, userInitiated: true as const },
};
const ok: ScriptExecutionResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false };

function setup(
  execute: (options: ScriptExecutionOptions) => Promise<ScriptExecutionResult | undefined>,
  overrides: Partial<PortableScriptRunnerOptions> = {},
) {
  const saved: ScriptRun[] = [];
  const seen: ScriptExecutionOptions[] = [];
  const host: PortableScriptRunnerOptions = {
    executor: {
      execute: async (options) => {
        seen.push(options);
        return (await execute(options)) ?? ok;
      },
    },
    resolve: vi.fn(async (_name, scope) => ({ meta, source: '', scope })),
    readConfig: vi.fn(async () => GezelConfigSchema.parse({})),
    workspaceWriteAllowed: vi.fn(async () => ({ ok: true })),
    dispatch: vi.fn(async () => undefined),
    persistRun: vi.fn(async (run) => {
      saved.push(structuredClone(run));
    }),
    createId: () => 'run-1',
    now: () => 1000,
    ...overrides,
  };
  return { host, saved, seen, runner: new PortableScriptRunner(host) };
}

describe('the host port', () => {
  it('passes the resolver’s provenance verdict to the executor, and always trusts standard scope', async () => {
    const trusted = setup(async () => undefined, {
      resolve: async (_n, scope) => ({ meta, source: '', scope, provenanceTrusted: true }),
    });
    await trusted.runner.run(request);
    expect(trusted.seen[0]?.provenanceTrusted).toBe(true);
    const plain = setup(async () => undefined);
    await plain.runner.run(request);
    expect(plain.seen[0]?.provenanceTrusted).toBe(false);
    const standard = setup(async () => undefined);
    await standard.runner.run({ ...request, scope: 'standard' });
    expect(standard.seen[0]?.provenanceTrusted).toBe(true);
  });

  it('refuses an inline source at standard scope before resolving anything', async () => {
    const { host, runner } = setup(async () => undefined);
    await expect(runner.run({ ...request, scope: 'standard', inlineSource: 'x' })).rejects.toThrow(
      /standard scope/,
    );
    expect(host.resolve).not.toHaveBeenCalled();
  });

  it('honours the host’s limits', async () => {
    const { runner } = setup(async () => undefined, {
      limits: { maxNestedDepth: 1, maxTimeoutMs: 5_000 },
    });
    await expect(runner.run({ ...request, depth: 2 })).rejects.toThrow(/max 1/);
    await expect(runner.run({ ...request, timeoutMs: 6_000 })).rejects.toThrow(
      /Invalid script timeout/,
    );
    const capped = setup(
      async (options) => {
        await options.onRequest('fs.read', { path: 'a' });
        await options.onRequest('fs.read', { path: 'b' });
      },
      { limits: { maxHostCalls: 1 } },
    );
    const run = await capped.runner.run(request);
    expect(run.status).toBe('error');
    expect(run.error).toContain('call limit');
  });

  it('lets the host describe an execution failure', async () => {
    const { runner } = setup(async () => ({ ...ok, exitCode: 1, stderr: 'raw' }), {
      describeFailure: () => 'the host’s reading of it',
    });
    expect((await runner.run(request)).error).toBe('the host’s reading of it');
  });

  it('scrubs a secret a handler saw from every snapshot and from the returned run', async () => {
    const { runner, saved } = setup(
      async (options) => {
        await options.onRequest('artifact.write', { path: 'a.md', content: 'x' });
        options.onNotification('script.log', { args: ['token is s3cr3t-value'] });
      },
      {
        dispatch: async (context) => {
          context.secrets.add('s3cr3t-value');
          return { authorization: 'Bearer s3cr3t-value' };
        },
      },
    );
    const run = await runner.run(request);
    const everything = [JSON.stringify(run), ...saved.map((s) => JSON.stringify(s))].join('\n');
    expect(everything).not.toContain('s3cr3t-value');
    expect(run.logs).toContain('[REDACTED]');
  });

  it('exposes the live capability ceiling to the host', async () => {
    let allowed: string[] = [];
    const { runner } = setup(
      async (options) => {
        await options.onRequest('fs.read', { path: 'a' });
      },
      {
        dispatch: async (context) => {
          allowed = [...context.capabilities.allowed];
          return null;
        },
      },
    );
    await runner.run(request);
    expect(allowed).toEqual(expect.arrayContaining(['workspace.read', 'artifacts.write']));
  });

  it('notes an OS sandbox fallback in the log', async () => {
    const { runner } = setup(async () => ({
      ...ok,
      sandboxFallback: 'trusted-readonly-macos-seatbelt-startup',
    }));
    expect((await runner.run(request)).logs).toContain('[sandbox]');
  });
});

describe('effects that outlive the guest', () => {
  it('records the outcome of a host call that settles after the guest ended', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { runner, saved } = setup(
      async (options) => {
        const pending = options.onRequest('artifact.write', { path: 'a.md', content: 'x' });
        pending.catch(() => {});
        // Leave only once the host call is genuinely in flight.
        await started;
        setTimeout(release, 20);
        return { ...ok, exitCode: 1, timedOut: true };
      },
      {
        dispatch: async () => {
          entered();
          await gate;
          return { saved: true };
        },
      },
    );
    const run = await runner.run(request);
    expect(run.status).toBe('error');
    expect(run.calls[0]?.error).toBeUndefined();
    expect(run.calls[0]?.outputSummary).toContain('saved');
    expect(saved.at(-1)?.calls[0]?.outputSummary).toContain('saved');
  });
});
