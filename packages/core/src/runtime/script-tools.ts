import type { ScriptMeta } from '../schemas/script.js';
import type { PortableToolActions } from './product-tools.js';
import type { PortableScripts } from './script-host.js';
import type { PortableStore } from './store.js';

/** The model uses the same installed sources and admission path as the script editor. */
export function portableScriptTools(
  store: PortableStore,
  scripts: PortableScripts,
): NonNullable<PortableToolActions['scripts']> {
  return {
    async list(projectId) {
      const items: Array<{
        name: string;
        scope: 'standard' | 'user' | 'project';
        meta: ScriptMeta;
      }> = scripts.list().map((meta) => ({ name: meta.name, scope: 'standard', meta }));
      if (scripts.authoring) {
        for (const scope of [{ scope: 'project', projectId }, { scope: 'user' }] as const) {
          for (const record of await store.listScriptSources(scope)) {
            const checked = await scripts.authoring.inspect(record.source, record.name);
            if (
              checked.meta &&
              !checked.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
            )
              items.push({ name: record.name, scope: scope.scope, meta: checked.meta });
          }
        }
      }
      return { items, count: items.length };
    },
    async run(name, inputs, session, scope) {
      const run = await scripts.run({
        projectId: session.projectId,
        scriptName: name,
        scope,
        inputs,
        trigger: { kind: 'chat', gezelId: session.gezelId, sessionId: session.id },
      });
      if (run.status !== 'ok')
        throw new Error(
          `Script run ${run.id} ${run.status}: ${run.error ?? 'No successful result'}`,
        );
      return {
        runId: run.id,
        status: run.status,
        output: run.output,
        calls: run.calls,
        logs: run.logs,
      };
    },
  };
}
