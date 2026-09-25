import {
  CreateScriptRequestSchema,
  type GetScriptSourceResponse,
  RunScriptRequestSchema,
  SaveScriptSourceRequestSchema,
  ScriptNameSchema,
} from '../schemas/script.js';
import { HttpStatusError } from './http/errors.js';
import { json } from './http/json.js';
import type { PortableScripts } from './script-host.js';
import {
  SCRIPT_EXISTS_MESSAGE,
  notFoundBody,
  savedSourceResponse,
  scriptCreatedResponse,
  scriptRunResponse,
} from './script-responses.js';
import type { EditableScriptScope } from './script-sources.js';
import type { PortableStore } from './store.js';

/** Ordinary GezelClient contracts. The compiler is a host port, never part of persistence. */
export async function handlePortableScriptRoute(
  store: PortableStore,
  scripts: PortableScripts,
  request: Request,
  url: URL,
): Promise<Response | null> {
  const path = url.pathname;
  if (path === '/api/sdk/types' && request.method === 'GET')
    return scripts.authoring
      ? json(scripts.authoring.sdkTypes())
      : json({ error: 'Script authoring is unavailable' }, 501);
  if (path === '/api/scripts/standard' && request.method === 'GET')
    return json({
      scripts: scripts
        .list()
        .map((meta) => ({ name: meta.name, meta, path: `standard/${meta.name}.ts` })),
    });
  if (path === '/api/scripts/standard/source' && request.method === 'GET')
    return json(await scripts.source(ScriptNameSchema.parse(url.searchParams.get('name'))));
  const user = /^\/api\/scripts\/user(?:\/(source))?$/.exec(path);
  const project = /^\/api\/projects\/([^/]+)\/(scripts(?:\/[^/]+)?|script-runs\/[^/]+)$/.exec(path);
  if (!user && !project)
    return path.startsWith('/api/scripts/')
      ? json({ error: 'Unsupported script operation' }, 501)
      : null;
  const projectId = project ? decodeURIComponent(project[1]!) : undefined;
  if (projectId && !(await store.getProject(projectId))) return json(notFoundBody('project'), 404);
  const action = project ? project[2]! : user![1] ? 'scripts/source' : 'scripts';
  if (action.startsWith('script-runs/') && request.method === 'GET') {
    const run = await store.getScriptRun(
      projectId!,
      decodeURIComponent(action.slice('script-runs/'.length)),
    );
    return run ? json(run) : json(notFoundBody('script run'), 404);
  }
  const scope: EditableScriptScope = projectId
    ? { scope: 'project', projectId }
    : { scope: 'user' };
  if (action === 'scripts/run' && request.method === 'POST') {
    const body = RunScriptRequestSchema.parse(await request.json());
    let run: Awaited<ReturnType<typeof scripts.run>>;
    try {
      run = await scripts.run({
        projectId: projectId!,
        scriptName: body.name,
        scope: body.scope,
        inputs: body.input,
        trigger: { kind: 'manual', userInitiated: true },
        signal: request.signal,
      });
    } catch (error) {
      // An unknown name is an actionable 404 naming what IS runnable, and
      // unparseable meta is the author's 422 — the same replies the desktop
      // gives, so a model self-corrects the same way on either host.
      if (error instanceof Error && error.name === 'ScriptNotFoundError') {
        const available = (await store.listScriptSources(scope))
          .map((record) => record.name)
          .join(', ');
        return json(
          { error: `script "${body.name}" not found. Available scripts: ${available || '(none)'}` },
          404,
        );
      }
      if (error instanceof Error && error.name === 'ScriptMetaError')
        return json({ error: `script "${body.name}" has invalid meta: ${error.message}` }, 422);
      throw error;
    }
    return json(scriptRunResponse(run));
  }
  const authoring = scripts.authoring;
  if (!authoring)
    return action === 'scripts' && request.method === 'GET'
      ? json({ scripts: [] })
      : json({ error: 'Script authoring is unavailable' }, 501);
  const inspect = async (record: GetScriptSourceResponse) => {
    let result: Awaited<ReturnType<typeof authoring.inspect>>;
    try {
      result = await authoring.inspect(record.source, record.name);
    } catch (error) {
      return { ...record, metaError: error instanceof Error ? error.message : String(error) };
    }
    return {
      ...record,
      ...(result.meta
        ? { meta: result.meta }
        : {
            metaError:
              result.diagnostics.find((d) => d.severity === 'error')?.message ??
              'Invalid script metadata',
          }),
    };
  };
  if (action === 'scripts' && request.method === 'GET') {
    const records = await store.listScriptSources(scope);
    const entries = [];
    // Bound compiler concurrency: opening a library must not create hundreds of workers.
    for (const record of records) {
      const result = await inspect(record);
      if (result.meta)
        entries.push({
          name: result.name,
          meta: result.meta,
          path: `${projectId ? `projects/${projectId}/` : ''}scripts/${result.name}.ts`,
        });
    }
    return json({ scripts: entries });
  }
  if (action === 'scripts/source' && request.method === 'GET') {
    const record = await store.readScriptSource(
      scope,
      ScriptNameSchema.parse(url.searchParams.get('name')),
    );
    return record ? json(await inspect(record)) : json(notFoundBody('script'), 404);
  }
  if (action === 'scripts' && request.method === 'POST') {
    const input = CreateScriptRequestSchema.parse(await request.json());
    const source =
      input.source ?? (await authoring.scaffold(input.name, input.description, input.template));
    const result = await store.saveScriptSource(scope, { name: input.name, source, create: true });
    if (result.status !== 'saved') throw new HttpStatusError(SCRIPT_EXISTS_MESSAGE, 409);
    return json(scriptCreatedResponse(input.name, source, result.hash), 201);
  }
  if (action === 'scripts/source' && request.method === 'PUT') {
    const input = SaveScriptSourceRequestSchema.parse(await request.json());
    const result = await store.saveScriptSource(scope, input);
    if (result.status === 'conflict') return json(result);
    // Persist first: invalid source and compiler failures must never lose edits.
    try {
      const checked = await authoring.inspect(input.source, input.name);
      return json(savedSourceResponse(result.hash, checked));
    } catch (error) {
      return json({
        ...result,
        metaOk: false,
        diagnostics: [
          {
            severity: 'error',
            source: 'runtime-compat',
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      });
    }
  }
  if (action === 'scripts/source' && request.method === 'DELETE') {
    const deleted = await store.deleteScriptSource(
      scope,
      ScriptNameSchema.parse(url.searchParams.get('name')),
    );
    return deleted ? json({ ok: true }) : json(notFoundBody('script'), 404);
  }
  return json({ error: 'Unsupported script operation' }, 501);
}
