import type { MediaFitContext } from '../../models/media-fit.js';
import type { EngineContext } from '../engine-context.js';

/** The media fit check's view of an engine context. */
export function mediaFitContext(ctx: Pick<EngineContext, 'catalog' | 'store'>): MediaFitContext {
  return {
    catalog: ctx.catalog,
    readConfig: () => ctx.store.readConfig(),
  };
}
