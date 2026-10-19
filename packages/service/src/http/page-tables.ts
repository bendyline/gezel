import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { type PageTableInfo, type PageTableRequest, pageReadIsDeclared } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { realpathContained, safeJoin } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import type { Store } from '../fs/store.js';
import { DuckQueryError, type DuckRunner, DuckUnavailableError } from '../observations/duck.js';
import { tableRelDir } from '../observations/layout.js';
import {
  type ObservationTableRef,
  listProjectTables,
  runQueryOnTables,
} from '../observations/query.js';
import { SqlRejectedError } from '../observations/statement-guard.js';
import { resolvePageReads } from '../project-type/script-tools.js';
import { resolveScopedPageFile } from './page-io.js';

export interface PageTableDeps {
  store: Store;
  catalog: CatalogService;
  duck: DuckRunner;
}
type Result = { status: 200 | 400 | 403 | 404 | 413 | 429 | 503; body: Record<string, unknown> };
const failure = (status: Result['status'], errorCode: string, error: string): Result => ({
  status,
  body: { errorCode, error },
});
const active = new WeakMap<Store, Map<string, number>>();
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Shared by the authenticated frame relay and visitor head. File scopes are
 * resolved afresh for all operations, including queries using old table names. */
export async function readPageTables(
  deps: PageTableDeps,
  args: { projectId: string; request: PageTableRequest },
): Promise<Result> {
  let running = active.get(deps.store);
  if (!running) {
    running = new Map();
    active.set(deps.store, running);
  }
  const count = running.get(args.projectId) ?? 0;
  if (count >= 2 || [...running.values()].reduce((a, b) => a + b, 0) >= 8)
    return failure(429, 'rate-limited', 'Too many concurrent table requests.');
  running.set(args.projectId, count + 1);
  try {
    return await execute(deps, args);
  } finally {
    const left = (running.get(args.projectId) ?? 1) - 1;
    if (left) running.set(args.projectId, left);
    else running.delete(args.projectId);
  }
}

async function execute(
  deps: PageTableDeps,
  { projectId, request }: { projectId: string; request: PageTableRequest },
): Promise<Result> {
  const project = await deps.store.getProject(projectId);
  if (!project) return failure(404, 'not-allowed', 'Project not found.');
  const scopes = await resolvePageReads(deps.catalog, project);
  if (!scopes) return failure(403, 'not-allowed', 'This project has no page read permissions.');
  const artifacts = deps.store.projectArtifactsDir(projectId);
  const authorized: { ref: ObservationTableRef; info: PageTableInfo }[] = [];
  for (const ref of await listProjectTables(deps.store, project)) {
    const tablePath = tableRelDir(ref.corpusDir, ref.table);
    const source = ref.source === 'workspace' ? 'workspace' : 'artifacts';
    const path = source === 'workspace' ? ref.sourceLabel : tablePath;
    // A connector table needs its entire directory, not just a readable manifest.
    const reads = source === 'artifacts' ? scopes.filter((s) => s.subtree) : scopes;
    if (!pageReadIsDeclared(reads, source, path)) continue;
    const file = await resolveScopedPageFile(deps, { projectId, source, path });
    if (!file.ok) continue;
    const info = await stat(file.full).catch(() => null);
    if (!info || (source === 'workspace' ? !info.isFile() : !info.isDirectory())) continue;
    const full = safeJoin(artifacts, tablePath);
    if (!full || !(await realpathContained(artifacts, full))) continue;
    // Derived table provenance must not be redirected to another corpus by a link.
    const physical = await realpath(full).catch(() => null);
    const physicalRoot = await realpath(artifacts);
    if (
      !physical ||
      relative(physicalRoot, physical) !== relative(resolve(artifacts), resolve(full))
    )
      continue;
    // Stable, page-local SQL names avoid collisions and rebinding when an unrelated
    // table appears. Do not expose names derived from tables outside the page scope.
    const name = `t_${createHash('sha256').update(`${source}\0${path}\0${ref.table}`).digest('hex').slice(0, 24)}`;
    authorized.push({
      ref: { ...ref, queryName: name },
      info: {
        name,
        title: ref.manifest.title ?? ref.table,
        source,
        path,
        rows: ref.state.totalRows,
        columnCount: ref.manifest.columns.length,
        updatedAt: ref.state.lastWriteAt,
        schemaInferred: ref.manifest.inferred === true,
      },
    });
  }
  let body: Record<string, unknown>;
  if (request.op === 'list') {
    body = { op: 'list', tables: authorized.map((t) => t.info) };
  } else if (request.op === 'describe') {
    const table = authorized.find((t) => t.info.name === request.table);
    if (!table) return failure(403, 'not-allowed', 'Table is not available to this page.');
    body = {
      op: 'describe',
      table: table.info,
      columns: table.ref.manifest.columns,
      description: table.ref.manifest.description,
      grain: table.ref.manifest.grain,
    };
  } else {
    if (request.tables?.some((name) => !authorized.some((t) => t.info.name === name)))
      return failure(403, 'not-allowed', 'Table is not available to this page.');
    const scope = authorized.filter((t) => !request.tables || request.tables.includes(t.info.name));
    if (scope.length === 0)
      return failure(503, 'unavailable', 'No readable tables have been indexed yet.');
    if (!deps.duck.available())
      return failure(503, 'unavailable', 'The data query engine is not available on this device.');
    try {
      const result = await runQueryOnTables(
        deps,
        projectId,
        scope.map((t) => t.ref),
        {
          sql: request.sql,
          limit: request.limit ?? 100,
          timeoutMs: 10_000,
          memoryLimit: '256MB',
          threads: 2,
        },
      );
      body = { op: 'query', ...result };
    } catch (error) {
      if (
        error instanceof DuckUnavailableError ||
        (error instanceof SqlRejectedError && error.cause instanceof DuckUnavailableError)
      )
        return failure(
          503,
          'unavailable',
          'The data query engine is not available on this device.',
        );
      if (error instanceof SqlRejectedError || error instanceof DuckQueryError)
        return failure(
          400,
          'invalid-input',
          error.message
            .replaceAll(artifacts, '[project data]')
            .replaceAll(artifacts.replaceAll('\\', '/'), '[project data]'),
        );
      return failure(
        503,
        'unavailable',
        'The table query could not finish. Refresh and try again.',
      );
    }
  }
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_RESPONSE_BYTES)
    return failure(
      413,
      'invalid-input',
      'Table result exceeds 1 MiB. Request fewer rows or columns.',
    );
  return { status: 200, body };
}
