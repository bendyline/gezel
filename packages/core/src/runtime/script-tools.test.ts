import { describe, expect, it, vi } from 'vitest';
import type { ScriptRun } from '../schemas/script.js';
import type { PortableScripts } from './script-host.js';
import { portableScriptTools } from './script-tools.js';
import { portableFixture } from './test-files.js';

describe('model access to authored scripts', () => {
  it('lists only valid sources from the current project and user library with required metadata', async () => {
    const { store } = portableFixture();
    await store.ensureLayout();
    const other = await store.createProject({ name: 'Other' });
    for (const [projectId, name] of [
      ['default', 'report'],
      ['default', 'broken'],
      [other.id, 'secret'],
    ] as const)
      await store.saveScriptSource(
        { scope: 'project', projectId },
        { name, source: name, create: true },
      );
    await store.saveScriptSource(
      { scope: 'user' },
      { name: 'helper', source: 'helper', create: true },
    );
    const meta = (name: string) => ({
      name,
      description: 'Report',
      requires: ['artifacts.write' as const],
      inputs: { title: { type: 'string' as const, description: 'Title', required: true } },
    });
    const scripts = {
      list: () => [meta('checkContains')],
      authoring: {
        inspect: async (_source: string, name: string) => ({
          meta: meta(name),
          diagnostics:
            name === 'broken'
              ? [
                  {
                    severity: 'error' as const,
                    source: 'typescript' as const,
                    message: 'Syntax error',
                  },
                ]
              : [],
        }),
      },
    } as unknown as PortableScripts;
    const result = (await portableScriptTools(store, scripts).list('default')) as {
      items: unknown[];
    };
    expect(result.items).toEqual([
      { name: 'checkContains', scope: 'standard', meta: meta('checkContains') },
      { name: 'report', scope: 'project', meta: meta('report') },
      { name: 'helper', scope: 'user', meta: meta('helper') },
    ]);
  });

  it('reports rejected execution as a failed tool with its durable run id', async () => {
    const { store } = portableFixture();
    await store.ensureLayout();
    const gezelId = (await store.readConfig()).meesterGezelId!;
    const session = await store.createSession({ gezelId, providerName: 'llama-cpp' });
    const run = vi.fn(
      async () =>
        ({
          id: 'failed-run',
          status: 'error',
          error: 'Capability artifacts.write was not declared',
        }) as ScriptRun,
    );
    await expect(
      portableScriptTools(store, { run } as unknown as PortableScripts).run(
        'report',
        { title: 'Brief' },
        session,
        'project',
      ),
    ).rejects.toThrow('Script run failed-run error: Capability');
    expect(run).toHaveBeenCalledWith({
      projectId: 'default',
      scriptName: 'report',
      scope: 'project',
      inputs: { title: 'Brief' },
      trigger: { kind: 'chat', gezelId, sessionId: session.id },
    });
  });
});
