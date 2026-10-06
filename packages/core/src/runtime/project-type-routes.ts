import { formatJsonSchemaViolations, validateJsonSchema } from '../json-schema/validate.js';
import {
  type ProjectTypeHost,
  normalizePagePath,
  pageReadIsDeclared,
  projectTypeHostGap,
  projectTypeModelTools,
  projectTypePageReads,
  projectTypePageTools,
  projectTypePageUsesApiV1,
  renderProjectTypeReactionSeed,
} from '../project-types/composition.js';
import type { CatalogItemDetail, ProjectTypeTool } from '../schemas/catalog.js';
import type { Craftbook } from '../schemas/craftbook.js';
import type { GezelSummary } from '../schemas/gezel.js';
import type { PageApiBootstrap } from '../schemas/page-bridge.js';
import { type Project, projectAllowsAmbientWork } from '../schemas/project.js';
import {
  InvokePageToolRequestSchema,
  PageReadRequestSchema,
  type ScriptRun,
} from '../schemas/script.js';
import { HttpStatusError } from './http/errors.js';
import { json } from './http/json.js';
import {
  type PortableProjectTypes,
  parseTypedProjectRequest,
  planPortableTypedProject,
  projectTypePageFile,
} from './project-types.js';
import type { PortableScripts } from './script-host.js';
import type { PortableStore } from './store.js';

/** A page tool is an interaction handler; anything slower is a design smell. */
export const PORTABLE_PAGE_INVOKE_TIMEOUT_MS = 30_000;
/** Hard ceiling on one page read, as on the desktop. */
export const PORTABLE_PAGE_READ_MAX_BYTES = 2 * 1024 * 1024;

export interface PortableProjectTypeRouteHost {
  store: PortableStore;
  types: PortableProjectTypes;
  templates(): readonly CatalogItemDetail[];
  craftbooks(): readonly { item: CatalogItemDetail; book: Craftbook }[];
  scripts: PortableScripts | undefined;
  host(): Promise<ProjectTypeHost>;
  /** Refuse new work while the app is in the background or a save failed. */
  assertNoConflict(): void;
  /** Run route work that changes the store, one at a time like every other route. */
  serial<T>(action: () => Promise<T>): Promise<T>;
  projectCreated(project: Project, hired: readonly string[]): void;
  /** Summon a gezel's turn with a page reaction's seed; null when engagement is off. */
  deliverReaction(args: {
    projectId: string;
    gezelId: string;
    seed: string;
    hidden: boolean;
    standalone: boolean;
  }): Promise<{ sessionId: string } | null>;
}

/**
 * The script-backed tools a session on this project registers for the model,
 * resolved from the bundled type the way the desktop resolves them from its
 * catalog. Empty when the project has no type or the type is not bundled.
 */
export async function portableProjectScriptTools(
  types: PortableProjectTypes,
  project: Pick<Project, 'projectType'> | null | undefined,
): Promise<ProjectTypeTool[]> {
  const entry = await types.forProject(project).catch(() => undefined);
  return entry ? projectTypeModelTools(entry.item.manifest) : [];
}

function etagOf(size: number, mtime: number): string {
  let hash = 0x811c9dc5;
  for (const char of `${size}:${Math.trunc(mtime)}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `p${hash.toString(36)}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

/**
 * Catalog project types on a host without the catalog service: the gallery,
 * typed creation, and the page bridge behind a type's Output page. Returns
 * null for any other request.
 */
export async function handlePortableProjectTypeRoute(
  host: PortableProjectTypeRouteHost,
  request: Request,
  url: URL,
): Promise<Response | null> {
  const parts = url.pathname.split('/').slice(2).map(decodeURIComponent);
  const [resource, id, action, child] = parts;
  const method = request.method;
  const query = url.searchParams;

  if (resource === 'catalog' && method === 'GET') {
    if (id === 'project-type' && !action)
      return json({ items: await host.types.summaries(await host.host()) });
    if (id === 'project-type' && action && !child) {
      const entry = await host.types.find(action, query.get('version') ?? undefined, true);
      if (!entry) throw new HttpStatusError('Project type not found', 404);
      const gap = projectTypeHostGap(entry.item.manifest, await host.host());
      return json({ ...entry.item, ...(gap ? { unavailableReason: gap } : {}) });
    }
    if (id === 'gezel-template' && !action)
      return json({
        items: host.templates().map(({ readme: _readme, about: _about, ...summary }) => summary),
      });
    if (id === 'craftbook-template' && !action)
      return json({
        items: host
          .craftbooks()
          .map(({ item: { readme: _readme, about: _about, ...summary } }) => summary),
      });
    return null;
  }

  if (resource !== 'projects') return null;

  if (id === 'typed' && !action && method === 'POST') {
    const body = parseTypedProjectRequest(await request.json());
    return json(
      await host.serial(async () => {
        host.assertNoConflict();
        const entry = await host.types.find(body.projectType.typeId, body.projectType.version);
        if (!entry)
          throw new HttpStatusError(
            body.projectType.version
              ? `Project type ${body.projectType.typeId}@${body.projectType.version} is not available on this device`
              : `Project type ${body.projectType.typeId} is not available on this device`,
            404,
          );
        const gap = projectTypeHostGap(entry.item.manifest, await host.host());
        if (gap) throw new HttpStatusError(gap, 409);
        const { plan, applied } = await planPortableTypedProject({
          request: body,
          entry,
          templates: host.templates(),
          installGezels: await host.store.listGezels(),
          craftbookAvailable: (craftbookId) =>
            host.craftbooks().some(({ book }) => book.id === craftbookId),
          now: new Date().toISOString(),
        });
        const created = await host.store.createTypedProject(plan, applied);
        host.projectCreated(created.project, created.hired);
        return { project: created.project, applied: created.applied };
      }),
    );
  }

  if (!id) return null;

  if (action === 'type' && method === 'GET' && (child === 'read' || child === 'bootstrap')) {
    const project = await host.store.getProject(id);
    if (!project) throw new HttpStatusError('Project not found', 404);
    const entry = await host.types.forProject(project);
    if (!entry) throw new HttpStatusError('This project has no project type on this device', 404);
    const path = normalizePagePath(query.get('path') ?? '');
    if (!path) throw new HttpStatusError('A page path is required');
    if (child === 'bootstrap') {
      const manifest = entry.item.manifest;
      const page = projectTypePageFile(entry, path);
      const bootstrap: PageApiBootstrap = {
        api: 1,
        projectId: id,
        source: 'type',
        entry: path,
        typeName: manifest.name,
        params: project.projectType?.params ?? {},
        tools: projectTypePageTools(manifest).map((tool) => tool.name),
      };
      // A phone serves a page as a snapshot with no preview URL, so a v0 page,
      // which reads its identity from that URL, would only ever show its demo.
      return json({
        bootstrap,
        apiV1: projectTypePageUsesApiV1(manifest, page && 'text' in page ? page.text : undefined),
      });
    }
    const file = projectTypePageFile(entry, path);
    if (!file) throw new HttpStatusError('Page file not found', 404);
    const bytes = 'text' in file ? new TextEncoder().encode(file.text) : file.bytes;
    return new Response(bytes as Uint8Array<ArrayBuffer>, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  if (action === 'page-read' && method === 'POST' && !child) {
    const body = PageReadRequestSchema.parse(await request.json());
    const project = await host.store.getProject(id);
    if (!project) return json({ error: 'project not found' }, 404);
    const entry = await host.types.forProject(project);
    if (!entry) return json({ error: 'project has no applied project type' }, 404);
    const requested = normalizePagePath(body.path);
    if (requested === null) return json({ error: 'bad path' }, 400);
    if (!pageReadIsDeclared(projectTypePageReads(entry.item.manifest), body.source, requested))
      return json({ error: 'path is not a declared page read' }, 403);
    const stat = await host.store.statFile(body.source, id, requested).catch(() => null);
    if (!stat) {
      // A page watches files a gezel has not written yet; its arrival must fire.
      if (body.op === 'stat') return json({ op: 'stat', etag: 'absent', exists: false });
      return json({ error: 'not found' }, 404);
    }
    if (body.op === 'stat' || body.op === 'list') {
      if (!stat.isDirectory) {
        if (body.op === 'list') return json({ error: 'not a directory' }, 400);
        return json({
          op: 'stat',
          etag: etagOf(stat.size, stat.mtime),
          size: stat.size,
          mtime: stat.mtime,
        });
      }
      const listing = await host.store.listFiles(body.source, id, requested, false, {
        includeHidden: true,
      });
      const entries = [];
      for (const child of listing.entries) {
        const info = await host.store.statFile(body.source, id, child.path).catch(() => null);
        if (!info) continue;
        entries.push({
          name: child.name,
          kind: info.isDirectory ? ('dir' as const) : ('file' as const),
          size: info.size,
          mtime: info.mtime,
        });
      }
      const etag = etagOf(
        entries.length,
        entries.reduce((sum, item) => sum + item.mtime + item.size + item.name.length, 0),
      );
      return body.op === 'list'
        ? json({ op: 'list', entries, etag, mtime: stat.mtime })
        : json({ op: 'stat', etag, mtime: stat.mtime });
    }
    if (stat.isDirectory) return json({ error: 'is a directory' }, 400);
    const cap = Math.min(
      body.maxBytes ?? PORTABLE_PAGE_READ_MAX_BYTES,
      PORTABLE_PAGE_READ_MAX_BYTES,
    );
    if (stat.size > cap)
      return json({ error: `file exceeds read cap (${stat.size} > ${cap} bytes)` }, 413);
    const bytes = await host.store.readFileBytes(body.source, id, requested);
    if (!bytes) return json({ error: 'not found' }, 404);
    const as = body.as ?? (requested.endsWith('.json') ? 'json' : 'text');
    return json({
      op: 'read',
      content: as === 'bytes' ? bytesToBase64(bytes) : new TextDecoder().decode(bytes),
      encoding: as === 'bytes' ? 'base64' : 'utf8',
      etag: etagOf(stat.size, stat.mtime),
      size: stat.size,
      mtime: stat.mtime,
    });
  }

  if (action === 'page-invoke' && method === 'POST' && !child) {
    const body = InvokePageToolRequestSchema.parse(await request.json());
    const project = await host.store.getProject(id);
    if (!project) return json({ error: 'project not found' }, 404);
    const entry = await host.types.forProject(project);
    if (!entry) return json({ error: 'project has no applied project type' }, 404);
    const manifest = entry.item.manifest;
    const tool = projectTypePageTools(manifest).find((item) => item.name === body.tool);
    if (!tool)
      return manifest.tools.some((item) => item.name === body.tool)
        ? json({ error: 'tool is not exposed to pages' }, 403)
        : json({ error: 'unknown tool' }, 404);
    if (tool.inputs) {
      const violations = validateJsonSchema(body.input ?? {}, tool.inputs);
      if (violations.length > 0)
        return json(
          { error: `input does not match tool schema: ${formatJsonSchemaViolations(violations)}` },
          400,
        );
    }
    if (!host.scripts) throw new HttpStatusError('Scripts are unavailable on this host', 501);
    host.assertNoConflict();
    // Runs outside the route queue: a page action waits for the script
    // executor, never every other request behind it.
    const run: ScriptRun = await host.scripts.run({
      projectId: id,
      scriptName: tool.script,
      scope: 'project',
      inputs: { ...(body.input ?? {}), ...(tool.bind ?? {}) },
      trigger: { kind: 'page', tool: tool.name },
      timeoutMs: PORTABLE_PAGE_INVOKE_TIMEOUT_MS,
      admission: 'wait',
    });
    let reaction: { delivered: boolean; gezelId?: string; reason?: string } | undefined;
    if (run.status === 'ok' && tool.reaction)
      reaction = await host.serial(() =>
        dispatchPortableReaction(host, {
          project,
          typeName: manifest.name,
          params: project.projectType?.params,
          tool,
          run,
        }),
      );
    return json({
      runId: run.id,
      status: run.status,
      output: run.output,
      callsSummary: run.calls.map((call) => ({
        kind: call.kind,
        durationMs: call.durationMs,
        ...(call.error ? { error: call.error } : {}),
      })),
      ...(run.error ? { error: run.error } : {}),
      ...(reaction ? { reaction } : {}),
    });
  }

  return null;
}

/**
 * The desktop's reaction rule: a page action summons the declared gezel's
 * turn, never a model's own tool call, and a failed summons never fails the
 * action that already applied.
 */
async function dispatchPortableReaction(
  host: PortableProjectTypeRouteHost,
  args: {
    project: Project;
    typeName: string;
    params: Record<string, unknown> | undefined;
    tool: ProjectTypeTool;
    run: ScriptRun;
  },
): Promise<{ delivered: boolean; gezelId?: string; reason?: string }> {
  const reaction = args.tool.reaction!;
  if (!projectAllowsAmbientWork(args.project))
    return { delivered: false, reason: 'project-inactive' };
  let target: GezelSummary | undefined;
  const gezels = await host.store.listGezels();
  for (const gezelId of args.project.gezelIds ?? []) {
    const gezel = gezels.find((item) => item.id === gezelId);
    if (gezel?.templateId === reaction.gezel) {
      target = gezel;
      break;
    }
  }
  const targetGezelId = target?.id ?? args.project.voormanGezelId;
  if (!targetGezelId) return { delivered: false, reason: 'no-target' };
  const seed = renderProjectTypeReactionSeed({
    typeName: args.typeName,
    prompt: reaction.prompt,
    tool: args.tool.name,
    ...(args.params ? { params: args.params } : {}),
    output: args.run.output,
  });
  try {
    const delivered = await host.deliverReaction({
      projectId: args.project.id,
      gezelId: targetGezelId,
      seed,
      hidden: reaction.hideSeed === true,
      standalone: reaction.standalone === true,
    });
    return delivered
      ? { delivered: true, gezelId: targetGezelId }
      : { delivered: false, gezelId: targetGezelId, reason: 'engagement-off' };
  } catch {
    return { delivered: false, gezelId: targetGezelId, reason: 'send-failed' };
  }
}
