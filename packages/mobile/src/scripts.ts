import { scripts } from 'virtual:gezel-portable-scripts';
import { sdkTypes } from 'virtual:gezel-portable-sdk-types';
import {
  type PortableScriptDefinition,
  PortableScriptRunner,
} from '@bendyline/gezel-script-runtime';
import { WebWorkerScriptExecutor } from '@bendyline/gezel-script-runtime/web-worker';
import {
  PortableScriptHost,
  type PortableScripts,
  type PortableStore,
  portableScriptSourceHash,
} from '@bendyline/gezel/runtime';
import { compileMobileScript, scaffoldMobileScript } from './script-compiler.js';

export class MobileQuickJSExecutor extends WebWorkerScriptExecutor {
  constructor() {
    super(
      () =>
        new Worker(new URL('./script-worker.ts', import.meta.url), {
          type: 'module',
          name: 'gezel-script',
        }),
    );
  }
}

/** No user source or edited metadata can acquire the immutable standard scope. */
export async function resolveMobileScript(
  name: string,
  scope: string,
): Promise<PortableScriptDefinition> {
  if (scope !== 'standard')
    throw new Error('This device currently runs bundled standard scripts only');
  if (!Object.hasOwn(scripts, name))
    throw new Error(`Script "${name}" is not bundled on this device`);
  return structuredClone(scripts[name]!);
}

export function listMobileScripts(): PortableScriptDefinition['meta'][] {
  return Object.values(scripts).map((script) => structuredClone(script.meta));
}

export function createMobileScripts(store: PortableStore): PortableScripts {
  const host = new PortableScriptHost(store);
  const runner = new PortableScriptRunner({
    executor: new MobileQuickJSExecutor(),
    resolve: async (name, scope, context) => {
      if (scope === 'standard') return resolveMobileScript(name, scope);
      let record: Awaited<ReturnType<typeof store.readScriptSource>> = null;
      let sourceCraftbook: PortableScriptDefinition['sourceCraftbook'];
      if (scope === 'craftbook' && context.trigger.kind === 'step') {
        const task = await store.getTask(context.trigger.taskRef);
        if (
          !task ||
          task.projectId !== context.projectId ||
          task.activeStepId !== context.trigger.stepId ||
          task.status !== 'active'
        )
          throw new Error('Craftbook script task context is no longer active');
        const source = Object.hasOwn(task.craftbook.scripts ?? {}, name)
          ? task.craftbook.scripts![name]
          : undefined;
        if (source !== undefined) {
          record = { name, source, hash: await portableScriptSourceHash(source), mtimeMs: 0 };
          const origin = task.sourceCraftbookIds?.find((entry) => entry.role === 'main');
          sourceCraftbook = {
            id: task.craftbook.id,
            ...(task.craftbook.version ? { version: task.craftbook.version } : {}),
            ...(origin?.sourceId ? { sourceId: origin.sourceId } : {}),
          };
        }
      }
      record ??= await store.readScriptSource(
        scope === 'user' ? { scope } : { scope: 'project', projectId: context.projectId },
        name,
      );
      if (!record) throw new Error(`Script "${name}" was not found in ${scope} scope`);
      const compiled = await compileMobileScript(record.source, name);
      if (!compiled.javascript || !compiled.meta)
        throw new Error(
          compiled.diagnostics
            .filter((d) => d.severity === 'error')
            .map((d) => d.message)
            .join('\n') || 'Script compilation failed',
        );
      return {
        source: compiled.javascript,
        originalSource: record.source,
        hash: record.hash,
        meta: compiled.meta,
        scope,
        ...(sourceCraftbook ? { sourceCraftbook } : {}),
      };
    },
    readConfig: host.readConfig,
    persistRun: host.persistRun,
    workspaceWriteAllowed: host.workspaceWriteAllowed,
    dispatch: host.dispatch,
  });
  let controller: AbortController | undefined;
  let running: Promise<Awaited<ReturnType<typeof runner.run>>> | undefined;
  return {
    setTaskActions: (actions) => host.setTaskActions(actions),
    authoring: {
      inspect: compileMobileScript,
      scaffold: scaffoldMobileScript,
      sdkTypes: () => structuredClone(sdkTypes),
    },
    list: listMobileScripts,
    async source(name) {
      const definition = await resolveMobileScript(name, 'standard');
      return {
        name,
        source: definition.originalSource ?? definition.source,
        hash: definition.hash ?? '',
        mtimeMs: 0,
        meta: definition.meta,
        provenance: { kind: 'standard', ref: 'bundled' },
      };
    },
    initialize: () => store.recoverScriptRuns(),
    isBusy: () => !!running,
    async cancel() {
      controller?.abort();
      await running?.catch(() => {});
    },
    async run(options) {
      if (running) throw new Error('A script is already running on this device');
      const current = new AbortController();
      controller = current;
      const abort = () => current.abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      const promise = runner.run({ ...options, signal: current.signal });
      running = promise;
      try {
        return await promise;
      } finally {
        options.signal?.removeEventListener('abort', abort);
        if (running === promise) {
          running = undefined;
          controller = undefined;
        }
      }
    },
  };
}
