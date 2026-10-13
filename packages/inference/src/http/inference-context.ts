import type {
  GezelConfig,
  GezelDetail,
  GezelSummary,
  HistoryEvent,
  ProviderName,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { KnowledgeManager } from '../knowledge/manager.js';
import type { EnsureModelOrchestrator } from '../models/ensure.js';
import type { resolveModelSessionDefaults } from '../providers/session-defaults.js';
import type { LLMProvider, ModelInfo, TurnUsage } from '../providers/types.js';
import type { RelevanceModelManager } from '../relevance/manager.js';
import type {
  BeginExternalConversationInput,
  ExternalConversationTurn,
  ResolveExternalConversationInput,
} from './external-conversation-contract.js';
export interface InferenceContext {
  store: {
    readConfig(): Promise<GezelConfig>;
    getGezel?(id: string): Promise<GezelDetail | null>;
    listGezels?(): Promise<GezelSummary[]>;
  };
  catalog: CatalogService;
  chat: {
    getProviderForModel(name: ProviderName, model?: string): Promise<LLMProvider>;
    listModelsForProvider(name: ProviderName): Promise<ModelInfo[]>;
    resolveModelSessionDefaults(
      name: ProviderName,
      model: string | undefined,
      overrides?: Parameters<typeof resolveModelSessionDefaults>[4],
    ): ReturnType<typeof resolveModelSessionDefaults>;
    providerForGezel?(id: string): Promise<ProviderName>;
    recordExternalUsage?(name: ProviderName, usage: TurnUsage): void;
    resolveExternalConversationId?(input: ResolveExternalConversationInput): Promise<string>;
    beginExternalConversation?(
      input: BeginExternalConversationInput,
    ): Promise<ExternalConversationTurn>;
  };
  history?: {
    log(event: Omit<HistoryEvent, 'id' | 'at'> & { at?: string; id?: string }): Promise<void>;
  };
  knowledge?: KnowledgeManager;
  relevance: RelevanceModelManager;
  ensureModel: EnsureModelOrchestrator;
}
