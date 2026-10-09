import { z } from 'zod';
import {
  type CreateGezelRequest,
  CreateGezelRequestSchema,
  CreateProjectRequestSchema,
  RerollGezelPoppetjeRequestSchema,
  UpdateGezelPoppetjeRequestSchema,
  UpdateGezelSettingsRequestSchema,
  UpdateProjectRequestSchema,
} from '../schemas/api.js';
import type { GezelDetail } from '../schemas/gezel.js';
import {
  CreatePromptDraftRequestSchema,
  DuplicatePromptDraftRequestSchema,
  PatchPromptDraftRequestSchema,
  type PromptDraftMeta,
} from '../schemas/prompt-draft.js';
import type { ChatSession } from '../schemas/session.js';
import type { ChatEventBus } from './chat-events.js';
import { decodeText } from './files.js';
import type { PortableGrowth } from './growth-engine.js';
import { handlePortableGrowthRoute } from './growth-host.js';
import { portableWorkspaceHtmlPages } from './html-pages.js';
import { HttpStatusError as ProductError } from './http/errors.js';
import { json } from './http/json.js';
import type { PortableStore } from './store.js';
import type { PortableTaskRunner } from './task-routes.js';

/**
 * What the project, gezel, document and file routes reach in the product
 * service. They run under its admission lock like every other route.
 */
export interface PortableEntityRouteHost {
  store: PortableStore;
  eventBus: ChatEventBus;
  tasks: Pick<PortableTaskRunner, 'isBusy'>;
  growth: PortableGrowth;
  /** A conversation as the service holds it, including one whose save is pending. */
  session(id: string): Promise<ChatSession>;
  /** Refuse to delete or archive conversations that still have work in flight. */
  assertSessionsFree(
    match: (scope: Pick<ChatSession, 'id' | 'gezelId' | 'projectId'>) => boolean,
  ): void;
  draftChanged(draft: PromptDraftMeta, deleted?: boolean): void;
  createGezel(input: CreateGezelRequest): Promise<GezelDetail>;
}

/** A request field that must be a non-blank string. */
export const requiredString = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new ProductError(`${name} is required`);
  return value;
};

/** Every open conversation's messages in scope, oldest first, paged back from `before`. */
export async function portableTimeline(
  host: Pick<PortableEntityRouteHost, 'store' | 'session'>,
  query: URLSearchParams,
  projectId?: string,
  gezelId?: string,
): Promise<unknown> {
  const summaries = await host.store.listSessions({
    projectId: projectId ?? query.get('project') ?? undefined,
    gezelId: gezelId ?? query.get('gezel') ?? undefined,
  });
  const rows = [];
  for (const summary of summaries) {
    const session = await host.session(summary.id);
    if (session.archived) continue;
    for (const [index, message] of session.messages.entries())
      rows.push({
        ...message,
        _cursor: `${message.at}|${session.id}|${String(index).padStart(8, '0')}`,
        sessionId: session.id,
        gezelId: session.gezelId,
        projectId: session.projectId,
        sessionTitle: session.title,
        sessionCreatedAt: session.createdAt,
        sessionLastActivityAt: session.lastActivityAt,
        sessionProviderName: session.providerName,
        sessionModel: session.model,
        sessionLastTurnError: session.lastTurnError,
      });
  }
  rows.sort((a, b) => a._cursor.localeCompare(b._cursor));
  const before = query.get('before');
  const filtered = rows.filter((row) => !before || row._cursor < before);
  const limit = Math.min(500, Math.max(1, Number(query.get('limit')) || 100));
  const selected = filtered.slice(-limit);
  return {
    messages: selected.map(({ _cursor, ...row }) => row),
    hasMore: filtered.length > limit,
    nextCursor: selected[0]?._cursor,
  };
}

/** The project, gezel, document and file routes; anything else is not available here. */
export async function handlePortableEntityRoute(
  host: PortableEntityRouteHost,
  request: Request,
  url: URL,
  body: Record<string, unknown>,
  parts: string[],
): Promise<Response> {
  const [resource, id, action, child, subaction] = parts;
  const method = request.method;
  const query = url.searchParams;
  if (resource === 'projects') {
    if (!id) {
      if (method === 'GET') return json({ projects: await host.store.listProjects() });
      if (method === 'POST') {
        const project = await host.store.createProject(CreateProjectRequestSchema.parse(body));
        host.eventBus.publishProjectEvent(project.id, {
          type: 'project_created',
          projectId: project.id,
          name: project.name,
        });
        return json(project);
      }
    }
    if (id === 'poisoned' && method === 'GET') {
      const poisoned = [];
      for (const summary of await host.store.listSessions()) {
        const session = await host.session(summary.id);
        if (session.lastTurnError && !session.archived)
          poisoned.push({
            projectId: session.projectId,
            sessionId: session.id,
            gezelId: session.gezelId,
            error: session.lastTurnError,
          });
      }
      return json({ poisoned });
    }
    if (id) {
      const project = await host.store.getProject(id);
      if (!project) throw new ProductError('Project not found', 404);
      if (!action) {
        if (method === 'GET') return json(project);
        if (method === 'PUT')
          return json(await host.store.updateProject(id, UpdateProjectRequestSchema.parse(body)));
        if (method === 'DELETE') {
          host.assertSessionsFree((scope) => scope.projectId === id);
          if (host.tasks.isBusy())
            throw new ProductError('Wait for the task step to finish, or stop it first.', 409);
          const deleted = await host.store.deleteProject(id, {
            removeWorkspace: query.get('removeWorkspace') === '1',
          });
          host.eventBus.publishProjectEvent(id, {
            type: 'project_deleted',
            projectId: id,
            name: project.name,
          });
          return json({ ok: true, ...deleted });
        }
      }
      if (action === 'gezels') {
        const gezelId = method === 'POST' ? requiredString(body.gezelId, 'Gezel') : child;
        if (method === 'POST' && gezelId) await host.store.addGezelToProject(id, gezelId);
        if (method === 'DELETE' && gezelId) await host.store.removeGezelFromProject(id, gezelId);
        const current = await host.store.getProject(id);
        return json({
          projectId: id,
          gezelIds: current?.gezelIds ?? [],
          ...(method === 'POST' ? { added: !project.gezelIds?.includes(gezelId!) } : {}),
          ...(method === 'DELETE' ? { removed: project.gezelIds?.includes(gezelId!) } : {}),
        });
      }
      if (action === 'clear-errors' && method === 'POST') {
        let cleared = 0;
        for (const summary of await host.store.listSessions({ projectId: id })) {
          const session = await host.session(summary.id);
          if (session.lastTurnError) {
            delete session.lastTurnError;
            delete session.lastTurnErrorDetail;
            await host.store.writeSession(session);
            cleared++;
          }
        }
        return json({ cleared });
      }
      if (action === 'local-gezels' && method === 'GET' && !child)
        return json({ gezels: await host.store.listProjectLocalGezels(id) });
      if (action === 'workspace' || action === 'artifacts')
        return portableFileRoute(host.store, request, url, body, action, id, child);
      if (action === 'prompt-drafts') {
        if (
          parts.length > 5 ||
          (subaction &&
            !(
              (method === 'PUT' && subaction === 'content') ||
              (method === 'POST' && subaction === 'duplicate')
            ))
        )
          throw new ProductError('Unsupported prompt draft operation', 501);
        if (!child) {
          if (method === 'GET')
            return json({
              drafts: await host.store.listPromptDrafts(id, {
                gezelId: query.get('gezelId') ?? undefined,
                sessionId: query.has('sessionId')
                  ? query.get('sessionId') === 'new'
                    ? null
                    : query.get('sessionId')!
                  : undefined,
                status:
                  query.get('status') === 'sent'
                    ? 'sent'
                    : query.get('status') === 'draft'
                      ? 'draft'
                      : undefined,
              }),
            });
          if (method === 'POST') {
            const draft = await host.store.createPromptDraft(
              id,
              CreatePromptDraftRequestSchema.parse(body),
            );
            host.draftChanged(draft);
            return json(draft);
          }
        } else {
          if (method === 'GET') {
            const draft = await host.store.getPromptDraft(id, child);
            if (!draft) throw new ProductError('Draft not found', 404);
            return json(draft);
          }
          if (method === 'POST' && subaction === 'duplicate') {
            const draft = await host.store.duplicatePromptDraft(
              id,
              child,
              DuplicatePromptDraftRequestSchema.parse(body),
            );
            host.draftChanged(draft);
            return json(draft);
          }
          if (method === 'PUT' && subaction === 'content') {
            const before = await host.store.getPromptDraft(id, child);
            const result = await host.store.writePromptDraftContent(
              id,
              child,
              z.string().parse(body.content),
            );
            if (result.draft ?? before)
              host.draftChanged((result.draft ?? before)!, result.deleted);
            return json(result);
          }
          if (method === 'PATCH') {
            const draft = await host.store.patchPromptDraft(
              id,
              child,
              PatchPromptDraftRequestSchema.parse(body),
            );
            host.draftChanged(draft);
            return json(draft);
          }
          if (method === 'DELETE') {
            const before = await host.store.getPromptDraft(id, child);
            const deleted = await host.store.deletePromptDraft(id, child);
            if (before && deleted) host.draftChanged(before, true);
            return json({ ok: true, deleted });
          }
        }
      }
    }
  }
  if (resource === 'gezels') {
    if (!id) {
      if (method === 'GET') return json({ gezels: await host.store.listGezels() });
      if (method === 'POST') {
        const gezel = await host.createGezel(CreateGezelRequestSchema.parse(body));
        host.eventBus.publishGlobalEvent({
          type: 'gezel_created',
          gezelId: gezel.id,
          name: gezel.name,
        });
        return json(gezel);
      }
    }
    if (id === 'mention-candidates' && method === 'GET')
      return json({
        candidates: (await host.store.listGezels())
          .filter(
            (g) =>
              !query.get('query') ||
              `${g.name} ${g.role ?? ''}`.toLowerCase().includes(query.get('query')!.toLowerCase()),
          )
          .map((g) => ({
            id: g.id,
            label: g.name,
            description: g.role,
            roleBasedName: g.roleBasedName,
            group: 'team',
          })),
      });
    if (id) {
      const gezel = await host.store.getGezel(id);
      if (!gezel) throw new ProductError('Gezel not found', 404);
      if (!action) {
        if (method === 'GET') return json(gezel);
        if (method === 'DELETE') {
          host.assertSessionsFree((scope) => scope.gezelId === id);
          await host.store.deleteGezel(id);
          return json({ ok: true });
        }
      }
      if (action === 'poppetje') {
        if (method === 'GET') return json({ poppetje: await host.store.getGezelPoppetje(id) });
        if (method === 'PUT')
          return json({
            poppetje: await host.store.setGezelPoppetje(
              id,
              UpdateGezelPoppetjeRequestSchema.parse(body).poppetje,
            ),
          });
        if (method === 'POST' && child === 'reroll')
          return json({
            poppetje: await host.store.rerollGezelPoppetje(
              id,
              RerollGezelPoppetjeRequestSchema.parse(body),
            ),
          });
      }
      if (action === 'about' && method === 'PUT')
        return json(await host.store.updateGezelAbout(id, z.string().parse(body.source)));
      if (action === 'md' && method === 'PUT')
        return json(
          await host.store.updateGezelMarkdown(id, requiredString(body.source, 'Character')),
        );
      if (action === 'rename' && method === 'POST')
        return json(
          await host.store.updateGezelSettings(id, { name: requiredString(body.name, 'Name') }),
        );
      if (action === 'settings' && method === 'POST')
        return json(
          await host.store.updateGezelSettings(id, UpdateGezelSettingsRequestSchema.parse(body)),
        );
      if (action === 'growth')
        return json(await handlePortableGrowthRoute(host, id, method, body, child, subaction));
      if (action === 'projects' && method === 'GET')
        return json({
          projects: (await host.store.listProjects())
            .filter(
              (p) => p.id === 'default' || p.voormanGezelId === id || p.gezelIds?.includes(id),
            )
            .map((p) => ({
              projectId: p.id,
              projectName: p.name,
              precedence: p.voormanGezelId === id ? 'voorman' : 'fallback',
            })),
        });
    }
  }
  if (resource === 'documents')
    return portableFileRoute(host.store, request, url, body, 'documents', undefined, id);
  throw new ProductError(
    `This operation is not available on this host: ${request.method} ${url.pathname}`,
    501,
  );
}

async function portableFileRoute(
  store: PortableStore,
  request: Request,
  url: URL,
  body: Record<string, unknown>,
  area: 'workspace' | 'artifacts' | 'documents',
  projectId: string | undefined,
  action: string | undefined,
): Promise<Response> {
  const method = request.method;
  const query = url.searchParams;
  const path = query.get('path') ?? (typeof body.path === 'string' ? body.path : '');
  if (area === 'workspace' && action === 'html-pages' && method === 'GET')
    return json(await portableWorkspaceHtmlPages(store, projectId!));
  if (!action && method === 'GET') {
    const result = await store.listFiles(area, projectId, path, query.get('recursive') === '1', {
      withStats: query.get('stats') === '1',
      includeHidden: query.get('hidden') === '1',
    });
    return json({ files: result.entries, truncated: result.truncated });
  }
  if (action === 'read' && method === 'GET') {
    const bytes =
      area === 'documents'
        ? await store.readDocumentReference(path)
        : await store.readFileBytes(area, projectId, path);
    if (bytes === null) throw new ProductError('File not found', 404);
    if (query.get('raw') === '1')
      return new Response(bytes as Uint8Array<ArrayBuffer>, {
        headers: {
          'content-type': mimeFor(path),
          'content-disposition': 'attachment',
          'x-content-type-options': 'nosniff',
        },
      });
    return json({ path, content: decodeText(bytes), size: bytes.length, kind: 'document' });
  }
  if (action === 'stat' && method === 'GET') {
    const slash = path.lastIndexOf('/');
    const parent = slash < 0 ? '' : path.slice(0, slash);
    const result = await store.listFiles(area, projectId, parent, false, {
      withStats: true,
      includeHidden: true,
    });
    const entry = result.entries.find((e) => e.path === path);
    return json(
      entry
        ? {
            kind: entry.isDirectory ? 'dir' : 'file',
            mtime: entry.mtimeMs ? new Date(entry.mtimeMs).toISOString() : undefined,
          }
        : { kind: 'missing' },
    );
  }
  if (['write', 'file'].includes(action ?? '') && method === 'PUT') {
    if (typeof body.content !== 'string') throw new ProductError('File content is required');
    await store.writeFile(area, projectId, path, body.content);
    return json({ ok: true, path });
  }
  if (action === 'raw' && method === 'PUT') {
    await store.writeFileBytes(area, projectId, path, new Uint8Array(await request.arrayBuffer()), {
      createOnly: query.get('create') === '1',
    });
    return json({ ok: true, path });
  }
  if (action === 'mkdir' && method === 'POST') {
    await store.makeFolder(area, projectId, path);
    return json({ ok: true, path });
  }
  if ((action === 'delete' || action === 'path') && method === 'DELETE') {
    await store.deleteFile(area, projectId, path);
    return json({ ok: true });
  }
  if (action === 'rename' && method === 'POST') {
    const from = requiredString(body.fromPath, 'Source path');
    const to = requiredString(body.toPath, 'Destination path');
    await store.renameFile(area, projectId, from, to);
    return json({ ok: true, fromPath: from, toPath: to });
  }
  throw new ProductError('This file operation is not available on this host', 501);
}

function mimeFor(path: string): string {
  const extension = path.split('.').at(-1)?.toLowerCase();
  const types: Record<string, string> = {
    md: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    pdf: 'application/pdf',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
  };
  return types[extension ?? ''] ?? 'application/octet-stream';
}
