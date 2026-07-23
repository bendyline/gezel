import { createHash } from 'node:crypto';
import {
  type Craftbook,
  type ProjectCraftbookProvenance,
  craftbookFromDoc,
  createLogger,
  formatCraftbookDocErrors,
  parseCraftbookDoc,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { runtimeCraftbookFromTemplate } from '../craftbook/resolve.js';
import type { Store } from '../fs/store.js';
import { readBundledCraftbookScripts } from '../scripts/install.js';

const log = createLogger('project-type');

export interface CraftbookInstallInput {
  projectId: string;
  typeId: string;
  typeVersion: string;
  /** Catalog source the type resolved from — pins embedded-file reads. */
  source: string;
  craftbookIds: string[];
}

export interface CraftbookInstallResult {
  installed: string[];
  /** Already present and current, or user-modified (left alone). */
  skipped: string[];
  /** Ids that resolved nowhere or failed validation/write. */
  failed: string[];
}

/**
 * sha256 over the recipe fields of an installed book. Deliberately
 * excludes timestamps (createdAt/updatedAt churn on every write) so the
 * hash answers exactly one question: "does the on-disk copy still match
 * what this type version installed?" Key order is fixed by construction.
 */
export function craftbookContentHash(book: Craftbook): string {
  const canonical = {
    steps: book.steps,
    entryStepId: book.entryStepId,
    basedOn: book.basedOn ?? null,
    plan: book.plan ?? null,
    defaultAssignee: book.defaultAssignee ?? null,
    triggers: book.triggers ?? null,
    toolsets: book.toolsets ?? null,
    hooks: book.hooks ?? null,
    scripts: book.scripts ?? null,
    paramSchema: book.paramSchema ?? null,
    command: book.command ?? null,
    requirements: book.requirements ?? null,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

/**
 * Resolve one declared craftbook id for a type: an embedded CraftbookDoc
 * (`versions/<v>/craftbooks/<id>.json` in the type's catalog folder)
 * wins; a catalog `craftbook-template` id is the fallback. Embedded is
 * the spec's primary shape (type-private books); catalog references let
 * a type attach books that are also useful standalone.
 */
export async function resolveTypeCraftbook(
  catalog: CatalogService,
  input: Pick<CraftbookInstallInput, 'typeId' | 'typeVersion' | 'source'>,
  id: string,
  now: string,
): Promise<Craftbook | null> {
  const embedded = await catalog
    .readItemFile(
      'project-type',
      input.typeId,
      `craftbooks/${id}.json`,
      input.source,
      input.typeVersion,
    )
    .catch(() => null);
  if (embedded) {
    const parsed = parseCraftbookDoc(embedded.toString('utf8'), 'json');
    if (!parsed.ok) {
      log.warn(
        `craftbooks: embedded ${input.typeId}/craftbooks/${id}.json is invalid:\n${formatCraftbookDocErrors(parsed.errors)}`,
      );
      return null;
    }
    const converted = craftbookFromDoc(parsed.doc, { id, now });
    if (!converted.ok) {
      log.warn(
        `craftbooks: embedded ${input.typeId}/craftbooks/${id}.json failed conversion:\n${formatCraftbookDocErrors(converted.errors)}`,
      );
      return null;
    }
    return { ...converted.craftbook, version: converted.craftbook.version ?? '1.0.0' };
  }

  const detail = await catalog.get('craftbook-template', id).catch(() => null);
  if (!detail || detail.manifest.kind !== 'craftbook-template') return null;
  const scripts = await readBundledCraftbookScripts(catalog, detail.manifest).catch(
    () => undefined,
  );
  return runtimeCraftbookFromTemplate(detail.manifest, detail.about, scripts);
}

/**
 * Copy-install a type's declared craftbooks into the project
 * (`.gezel/craftbooks/`), stamping a provenance sidecar per book. The
 * copy rule from docs/project-types.md: craftbooks become user-editable
 * state, so re-apply skips unchanged copies and never clobbers a
 * user-modified one (hash drift → skip + warn; reconcile is manual).
 */
export async function installProjectTypeCraftbooks(
  deps: { store: Store; catalog: CatalogService },
  input: CraftbookInstallInput,
): Promise<CraftbookInstallResult> {
  const result: CraftbookInstallResult = { installed: [], skipped: [], failed: [] };
  const now = new Date().toISOString();

  for (const id of input.craftbookIds) {
    try {
      const book = await resolveTypeCraftbook(deps.catalog, input, id, now);
      if (!book) {
        log.warn(`craftbooks: ${input.typeId} declares '${id}' but it resolves nowhere; skipping`);
        result.failed.push(id);
        continue;
      }

      const sidecar = await deps.store.readProjectCraftbookProvenance(input.projectId, id);
      const existing = await deps.store.getProjectCraftbook(input.projectId, id).catch(() => null);
      if (sidecar && existing) {
        const onDiskHash = craftbookContentHash(existing);
        if (onDiskHash !== sidecar.contentHash) {
          log.warn(
            `craftbooks: '${id}' in project ${input.projectId} was modified after install; leaving the user's copy (reconcile manually)`,
          );
          result.skipped.push(id);
          continue;
        }
        if (
          sidecar.typeId === input.typeId &&
          sidecar.typeVersion === input.typeVersion &&
          onDiskHash === craftbookContentHash(book)
        ) {
          result.skipped.push(id);
          continue;
        }
      }

      await deps.store.writeProjectCraftbook(input.projectId, book);
      await deps.store.writeProjectCraftbookProvenance(input.projectId, id, {
        installedBy: 'project-type',
        typeId: input.typeId,
        typeVersion: input.typeVersion,
        bookVersion: book.version ?? '1.0.0',
        contentHash: craftbookContentHash(book),
        installedAt: now,
      } satisfies ProjectCraftbookProvenance);
      result.installed.push(id);
    } catch (err) {
      log.warn(
        `craftbooks: installing '${id}' into ${input.projectId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      result.failed.push(id);
    }
  }
  return result;
}
