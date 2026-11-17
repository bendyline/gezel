import type { CatalogService } from '@bendyline/gezel-catalog';
import type { WebsiteService } from '../connectors/natives/website-service.js';
import type { Store } from '../fs/store.js';
import { PromptConnectorService } from './service.js';
import { webPageResolver } from './web-page-resolver.js';

export { PromptConnectorService } from './service.js';
export type {
  PromptConnectorResolver,
  PromptConnectorTurnContext,
  TurnContextOptions,
  TurnInclusion,
} from './service.js';

/** The product's resolvers, one per core rule. A new connector's resolver joins this list. */
export function createPromptConnectors(deps: {
  store: Store;
  catalog: CatalogService;
  websites: WebsiteService;
}): PromptConnectorService {
  return new PromptConnectorService({
    store: deps.store,
    catalog: deps.catalog,
    resolvers: [webPageResolver({ websites: deps.websites, store: deps.store })],
  });
}
