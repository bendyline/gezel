import { z } from 'zod';
import { MemorySearchRequestSchema, UnifiedSearchRequestSchema } from '../schemas/api.js';
import { BackupRequestSchema, RestoreConfirmSchema } from '../schemas/storage.js';
import { PORTABLE_BACKUP_LIMITS } from './backup-zip.js';
import { type PortableMemoryScope, PortableSaveMemorySchema } from './memories.js';
import type { PortableStore } from './store.js';

// `Response.json()` is a static the WebView on this project's iOS floor (16.4)
// does not have; Safari gained it in 17. Build the response by hand so every
// supported device can read a route's reply.
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const ContentSchema = z.object({ content: z.string() }).strict();
const ExportSchema = BackupRequestSchema.omit({ outPath: true }).strict();
export interface PortableDataRouteOptions {
  /** Restore cannot replace a product tree while a chat/tool/task writes it. */
  beforeRestore?: () => void | Promise<void>;
  changed?: (kind: 'memory' | 'restore') => void;
}
async function boundedBody(request: Request, maximum: number): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('A backup file is required');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > maximum) throw new Error('The imported backup exceeds this device’s size limit');
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
/** Called after the product service authenticates its human-facing API request. */
export async function handlePortableDataRequest(
  store: PortableStore,
  request: Request,
  url: URL,
  options: PortableDataRouteOptions = {},
): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;
  if (path === '/api/search' && method === 'POST')
    return json(await store.search(UnifiedSearchRequestSchema.parse(await request.json())));
  if (path === '/api/search/quick' && method === 'GET')
    return json(
      await store.search({
        query: url.searchParams.get('q') || ' ',
        mode: 'names',
        maxResults: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 20,
      }),
    );
  if (path === '/api/documents/search' && method === 'GET')
    return json(
      await store.searchDocuments({
        q: url.searchParams.get('q') ?? '',
        maxResults: url.searchParams.has('maxResults')
          ? Number(url.searchParams.get('maxResults'))
          : undefined,
      }),
    );
  if (path.startsWith('/api/memory/')) {
    const scope = z
      .enum(['gezel', 'project'])
      .parse(url.searchParams.get('scope') ?? 'gezel') as PortableMemoryScope;
    const id = url.searchParams.get('id') ?? '';
    if (path === '/api/memory/search' && method === 'POST')
      return json(
        await store.searchMemories(MemorySearchRequestSchema.parse(await request.json())),
      );
    if (path === '/api/memory/save' && method === 'POST') {
      const result = await store.saveMemory(PortableSaveMemorySchema.parse(await request.json()));
      options.changed?.('memory');
      return json(result);
    }
    if (path === '/api/memory/days' && method === 'GET')
      return json({ days: await store.listMemoryDays(scope, id) });
    if (path === '/api/memory/day' && method === 'GET')
      return json({
        content: await store.readMemoryDay(scope, id, url.searchParams.get('day') ?? ''),
      });
    if (path === '/api/memory/day' && method === 'PATCH') {
      const { content } = ContentSchema.parse(await request.json());
      const result = await store.updateMemoryDay(
        scope,
        id,
        url.searchParams.get('day') ?? '',
        content,
      );
      options.changed?.('memory');
      return json(result);
    }
    if (path === '/api/memory/summary' && method === 'GET')
      return json({ content: await store.readMemorySummary(scope, id) });
    if (path === '/api/memory/lessons' && method === 'GET')
      return json({
        content: await store.readMemoryLessons(url.searchParams.get('gezelId') ?? ''),
      });
    if (path === '/api/memory/lessons' && method === 'PUT') {
      const { content } = ContentSchema.parse(await request.json());
      await store.writeMemoryLessons(url.searchParams.get('gezelId') ?? '', content);
      options.changed?.('memory');
      return json({ ok: true });
    }
    if (path === '/api/memory/recent' && method === 'GET') {
      const count = z
        .number()
        .int()
        .min(1)
        .max(30)
        .parse(url.searchParams.has('days') ? Number(url.searchParams.get('days')) : 7);
      const days = (await store.listMemoryDays(scope, id)).slice(0, count);
      const parts = await Promise.all(
        days.map(async (day) => `# ${day}\n${await store.readMemoryDay(scope, id, day)}`),
      );
      return json({ content: parts.join('\n\n') });
    }
  }
  if (path === '/api/storage/backup/plan' && method === 'GET')
    return json(
      await store.planBackup({
        excludeWorkspaces: url.searchParams.get('excludeWorkspaces') === '1',
      }),
    );
  if (path === '/api/storage/backup/export' && method === 'POST') {
    const result = await store.exportBackup(ExportSchema.parse(await request.json()));
    return new Response(result.bytes.slice(), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="gezel-backup.zip"',
        'Cache-Control': 'no-store',
      },
    });
  }
  if (path === '/api/storage/restore/upload' && method === 'POST') {
    const bytes = await boundedBody(request, PORTABLE_BACKUP_LIMITS.archiveBytes);
    return json(await store.scanRestore(bytes));
  }
  const restore = /^\/api\/storage\/restore\/([^/]+)\/(confirm|cancel)$/.exec(path);
  if (restore && method === 'POST') {
    const id = decodeURIComponent(restore[1]!);
    if (restore[2] === 'cancel') return json(await store.cancelRestore(id));
    const input = RestoreConfirmSchema.parse(await request.json());
    await options.beforeRestore?.();
    const result = await store.confirmRestore(id, input);
    options.changed?.('restore');
    return json(result);
  }
  return null;
}
