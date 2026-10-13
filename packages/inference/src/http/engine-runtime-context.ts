import type { CatalogService } from '@bendyline/gezel-catalog';
import type { EngineBinaryRegistry } from '../engines/registry.js';
import type { ConfigStore } from '../fs/config-store.js';
import type { LlamaCppModelManager } from '../providers/llama-cpp/models.js';
import type { MlxModelManager } from '../providers/mlx/models.js';
import type { NativeInference } from '../providers/native/inference.js';
export interface EngineRuntimeContext {
  home: string;
  store: Pick<ConfigStore, 'readConfig' | 'writeConfig' | 'homePath'>;
  catalog: CatalogService;
  chat: NativeInference;
  engineBinaries: EngineBinaryRegistry;
  llamaCppModels: LlamaCppModelManager;
  ds4Models: LlamaCppModelManager;
  mlxModels: MlxModelManager;
  machineEngine?: {
    isConnected(): boolean;
    isRequired(): boolean;
    proxy(request: Request, from: string, to: string): Promise<Response>;
  };
  recognition?: { reset(): Promise<void> };
  imageProvider?: { reset(): Promise<void> };
  stt?: { reset(): Promise<void> };
}
