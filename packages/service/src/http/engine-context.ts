import type { HealthResponse, ResolvedDistributionPolicy, ServiceRole } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { EngineBinaryRegistry } from '@bendyline/gezel-inference/internal/engines/registry';
import type { ConfigStore } from '@bendyline/gezel-inference/internal/fs/config-store';
import type { EnsureModelOrchestrator } from '@bendyline/gezel-inference/internal/models/ensure';
import type { GpuArbiter } from '@bendyline/gezel-inference/internal/providers/gpu-arbiter';
import type { LlamaCppModelManager } from '@bendyline/gezel-inference/internal/providers/llama-cpp/index';
import type { MlxModelManager } from '@bendyline/gezel-inference/internal/providers/mlx/index';
import type { NativeInference } from '@bendyline/gezel-inference/internal/providers/native/inference';
import type { MlxRuntimeStatusBus } from '@bendyline/gezel-inference/internal/python/mlx-runtime-status-bus';
import type { UvRuntime } from '@bendyline/gezel-inference/internal/python/uv-runtime';
import type { DeviceIdentity } from '@bendyline/gezel-inference/internal/remotes/identity';
import type { DebugFlag } from '../debug/flag.js';
import type { ModelFitnessManager } from '../fitness/manager.js';
import type { FirstPartyAppTokens } from '../grants/first-party-apps.js';
import type { GrantManager } from '../grants/manager.js';
import type { ChatModelInstallRegistries } from '../models/install-jobs.js';
import type { SpeechToTextProviderManager } from '../providers/audio/stt-manager.js';
import type { TextToSpeechProviderManager } from '../providers/audio/tts-manager.js';
import type { ImageProviderManager } from '../providers/image/manager.js';
import type { ImageModelPullRegistry } from '../providers/image/pull-registry.js';
import type { RecognitionManager } from '../providers/recognition/manager.js';
import type { VideoProviderManager } from '../providers/video/manager.js';
import type { VideoModelPullRegistry } from '../providers/video/pull-registry.js';
import type { PairingCodes } from '../remotes/pairing-code.js';
import type { RemoteServingController } from '../remotes/serving.js';
import type { TenantLimiter } from '../remotes/tenant-limits.js';
import type { SpawnCapability } from '../system/spawn-capability.js';
import type { TokenStore } from './token-store.js';
/** Engine and model capabilities shared by local and machine-backed HTTP surfaces.
 * No project store, product chat sessions, credentials, tools, terminals or background jobs.
 */
export interface EngineContext {
  store: Pick<ConfigStore, 'readConfig' | 'writeConfig' | 'homePath'>;
  chat: NativeInference;
  signIdentityCertificate(): Promise<string | null>;
  serviceRole: ServiceRole;
  distribution: ResolvedDistributionPolicy;
  home: string;
  /**
   * The Office listener's live origin (`https://localhost:<port>`), or null
   * when it is not listening. The one browser origin allowed to register an
   * app grant; see `routes/v1-apps.ts`. Unset on the machine engine.
   */
  officeHostOrigin?: () => string | null;
  /** Checks the Office pane's enrollment key; see `routes/v1-apps.ts`. Unset on the machine engine. */
  verifyOfficeEnrollmentKey?: (key: string) => Promise<boolean>;
  /** Code-free grants for Gezel's own local add-ins. Unset on the machine engine. */
  firstPartyApps?: FirstPartyAppTokens;
  catalog: CatalogService;
  imageProvider: ImageProviderManager;
  imagePulls: ImageModelPullRegistry;
  chatInstalls: ChatModelInstallRegistries;
  videoProvider: VideoProviderManager;
  videoPulls: VideoModelPullRegistry;
  engineBinaries: EngineBinaryRegistry;
  stt: SpeechToTextProviderManager;
  tts: TextToSpeechProviderManager;
  recognition: RecognitionManager;
  gpuArbiter: GpuArbiter;
  llamaCppModels: LlamaCppModelManager;
  ds4Models: LlamaCppModelManager;
  modelFitness: ModelFitnessManager;
  mlxModels: MlxModelManager;
  uvRuntime: UvRuntime;
  mlxRuntimeStatus: MlxRuntimeStatusBus;
  debug: DebugFlag;
  token: string;
  tokenStore: TokenStore;
  grants: GrantManager;
  /**
   * This device's pairing identity. Null in the embedded inference profile,
   * which keeps no secrets and offers no remote connectivity.
   */
  deviceIdentity: DeviceIdentity | null;
  machineEngine?: {
    isConnected(): boolean;
    isRequired(): boolean;
    proxy(request: Request, sourcePrefix: string, targetPrefix: string): Promise<Response>;
    stop(): Promise<void>;
  };
  remoteServing: RemoteServingController;
  /** Connect codes for the LAN listener above (Settings → Remote Servers → Add a device). */
  pairingCodes: PairingCodes;
  remoteTenantLimits: TenantLimiter;
  tlsCertSha256?: string;
  tlsCertPem?: string;
  ensureModel: EnsureModelOrchestrator;
  startedAt: string;
  childProcessSpawn?: SpawnCapability;
  /** Windows product daemon only: the script container's current state, for health. */
  scriptSandbox?: () => NonNullable<HealthResponse['scriptSandbox']>;
}
