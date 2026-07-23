import { createLogger } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { Store } from '../fs/store.js';

const log = createLogger('gezels:reset-templates');

export interface ResetTemplateGezelsResult {
  /** ids of gezels whose about.md was rewritten from their catalog template. */
  reset: string[];
  /**
   * ids left untouched — no `templateId` (bespoke / LLM-authored),
   * fixed-function (no about.md at all), or the template/about could not
   * be resolved from the catalog.
   */
  skipped: string[];
}

/**
 * Restore every template-derived gezel's `about.md` back to the prose its
 * catalog template ships, discarding any user edits. Bespoke gezels (no
 * `templateId`) and fixed-function gezels (no about.md) are left alone.
 *
 * Pins to the gezel's recorded `templateVersion` when present so the reset
 * matches exactly what the gezel was created from; falls back to the
 * template's latest version otherwise.
 *
 * Best-effort per gezel: a single failed reset is logged and the gezel is
 * added to `skipped`, never aborting the sweep.
 */
export async function resetTemplateGezels(args: {
  store: Store;
  catalog: CatalogService;
}): Promise<ResetTemplateGezelsResult> {
  const { store, catalog } = args;
  const gezels = await store.listGezels();
  const reset: string[] = [];
  const skipped: string[] = [];
  for (const g of gezels) {
    if (!g.templateId || g.fixedFunction) {
      skipped.push(g.id);
      continue;
    }
    try {
      const detail = await catalog.get(
        'gezel-template',
        g.templateId,
        undefined,
        g.templateVersion,
      );
      const about = detail?.manifest.kind === 'gezel-template' ? detail.about : undefined;
      if (!about) {
        skipped.push(g.id);
        continue;
      }
      await store.updateGezelAbout(g.id, about);
      reset.push(g.id);
    } catch (err) {
      log.warn(
        `[reset-templates] failed to reset ${g.id} (template ${g.templateId}):`,
        err instanceof Error ? err.message : err,
      );
      skipped.push(g.id);
    }
  }
  return { reset, skipped };
}
