import { type GezelConfig, createLogger } from '@bendyline/gezel';
import type { InstallEvent, LlamaCppModelManager } from '../providers/llama-cpp/models.js';
import type { MlxInstallEvent, MlxModelManager } from '../providers/mlx/models.js';
import { decideAutoInstall } from '../providers/recognition/auto-install.js';
import type { RecognitionManager } from '../providers/recognition/manager.js';
import { ChatModelInstallRegistry } from './install-registry.js';

const log = createLogger('models');

export interface GgufInstallOpts {
  skipSha: boolean;
  /**
   * Fetch the vision projector the catalog ships. Defaults to on when
   * omitted; only ds4 (no sidecar path) passes `false`. Loading it is a
   * separate per-model runtime decision — see `config.nativeVision`.
   */
  includeMmproj?: boolean;
  /** Whether a text-only chat install should also pull the default image reader. */
  installCompanion: boolean;
}

export interface MlxInstallOpts {
  skipSha: boolean;
}

export type GgufInstallRegistry = ChatModelInstallRegistry<InstallEvent, GgufInstallOpts>;
export type MlxChatInstallRegistry = ChatModelInstallRegistry<MlxInstallEvent, MlxInstallOpts>;

export interface ChatModelInstallRegistries {
  llamaCpp: GgufInstallRegistry;
  ds4: GgufInstallRegistry;
  mlx: MlxChatInstallRegistry;
}

/**
 * Build the three background install registries the chat-model install
 * routes are consumers of. The install jobs live here, not in the HTTP
 * layer, so a client disconnect can no longer abandon a download — the
 * failure mode that used to strand multi-GB `.partial` trees with no
 * record they ever existed.
 *
 * By default the llama-cpp job additionally carries the companion image-reader
 * pull (previously inlined in the route): the chat model's own `done` is held
 * back until the companion finishes, because every consumer treats `done` as
 * terminal and would detach while the reader was still downloading. Callers
 * with an explicit bundle plan can suppress it through `installCompanion`.
 */
export function buildChatModelInstallRegistries(opts: {
  home: string;
  readConfig: () => Promise<GezelConfig | null>;
  llamaCppModels: LlamaCppModelManager;
  ds4Models: LlamaCppModelManager;
  mlxModels: MlxModelManager;
  recognition: RecognitionManager;
  /** Fired on install success, before `done` reaches subscribers — bust
   *  the `/api/models` cache here so observers re-fetch fresh state. */
  onDone: (engine: 'llama-cpp' | 'ds4' | 'mlx', id: string) => void;
}): ChatModelInstallRegistries {
  const llamaCpp: GgufInstallRegistry = new ChatModelInstallRegistry({
    engine: 'llama-cpp',
    run: (id, o) => runGgufInstallWithCompanion(id, o, opts),
    onDone: (id) => opts.onDone('llama-cpp', id),
  });
  const ds4: GgufInstallRegistry = new ChatModelInstallRegistry({
    engine: 'ds4',
    run: (id, o) => opts.ds4Models.install(id, o),
    onDone: (id) => opts.onDone('ds4', id),
  });
  const mlx: MlxChatInstallRegistry = new ChatModelInstallRegistry({
    engine: 'mlx',
    run: (id, o) => opts.mlxModels.install(id, o),
    onDone: (id) => opts.onDone('mlx', id),
  });
  return { llamaCpp, ds4, mlx };
}

async function* runGgufInstallWithCompanion(
  catalogId: string,
  o: GgufInstallOpts,
  deps: {
    home: string;
    readConfig: () => Promise<GezelConfig | null>;
    llamaCppModels: LlamaCppModelManager;
    recognition: RecognitionManager;
  },
): AsyncGenerator<InstallEvent> {
  let finished: InstallEvent | null = null;
  for await (const event of deps.llamaCppModels.install(catalogId, o)) {
    if (event.type === 'done') {
      finished = event;
      continue;
    }
    yield event;
  }
  if (!finished) return;
  if (o.installCompanion) yield* companionRecognitionEvents(catalogId, deps);
  yield finished;
}

/**
 * Pull an image reader alongside a chat model that can't see images, and
 * surface its progress as `companion` events on the same install stream.
 *
 * A failure here is logged and surfaced as a `companion` error, never as an
 * install failure: the chat model the user actually asked for is already on
 * disk and working.
 */
async function* companionRecognitionEvents(
  catalogId: string,
  deps: {
    home: string;
    readConfig: () => Promise<GezelConfig | null>;
    llamaCppModels: LlamaCppModelManager;
    recognition: RecognitionManager;
  },
): AsyncGenerator<InstallEvent> {
  const config = await deps.readConfig();
  if (!config) return;
  let decision: Awaited<ReturnType<typeof decideAutoInstall>> = null;
  try {
    decision = await decideAutoInstall({
      home: deps.home,
      config,
      catalogId,
      llamaCppModels: deps.llamaCppModels,
      recognition: deps.recognition,
    });
  } catch (err) {
    log.warn(`image-reader auto-install check failed: ${String(err)}`);
    return;
  }
  if (!decision) return;

  const { entry } = decision;
  log.info(`auto-installing image reader ${entry.id} — ${decision.reason}`);
  const companion = (
    extra: Partial<Extract<InstallEvent, { type: 'companion' }>>,
  ): Extract<InstallEvent, { type: 'companion' }> => ({
    type: 'companion',
    kind: 'image-recognition',
    id: entry.id,
    name: entry.name,
    bytesWritten: 0,
    totalBytes: entry.approxSizeBytes,
    ...extra,
  });

  try {
    yield companion({});
    const provider = await deps.recognition.current();
    for await (const event of provider.pullModel(entry.id, entry.spec)) {
      if (event.type === 'progress') {
        yield companion({
          bytesWritten: event.bytesWritten,
          totalBytes: event.totalBytes ?? entry.approxSizeBytes,
        });
      } else if (event.type === 'error') {
        yield companion({ error: event.error });
        return;
      }
    }
    yield companion({ bytesWritten: entry.approxSizeBytes });
    // The engine picks up the newly-installed weights on its next start.
    await deps.recognition.reset();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`image-reader auto-install failed: ${message}`);
    yield companion({ error: message });
  }
}
