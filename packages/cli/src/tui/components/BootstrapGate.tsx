import type {
  CatalogItemSummary,
  NativeEngineName,
  NativeEngineResolveEvent,
  NativeEngineStatusResponse,
  RecoDevice,
} from '@bendyline/gezel';
import { formatModelAttribution } from '@bendyline/gezel';
import type {
  ConfigResponse,
  GezelClient,
  LlamaCppInstallEvent,
  MlxInstallEvent,
} from '@bendyline/gezel-client/node';
import { Box, Text, useApp, useInput } from 'ink';
import type { JSX, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type BootstrapAccessoryModel,
  type BootstrapChatModel,
  type BootstrapChatProvider,
  NATIVE_TOOLKIT,
  bootstrapChatModelLabel,
  formatDownloadSize,
  pickAccessoryModels,
  rankChatModels,
} from '../bootstrap.js';

type DownloadEvent =
  | NativeEngineResolveEvent
  | LlamaCppInstallEvent
  | MlxInstallEvent
  | {
      type: string;
      bytesWritten?: number;
      totalBytes?: number;
      bytesWrittenAll?: number;
      totalBytesAll?: number;
      error?: string;
    };

interface BootstrapContext {
  config: ConfigResponse;
  provider: BootstrapChatProvider;
  device: RecoDevice;
  chatCatalog: CatalogItemSummary[];
  nativeStatus: NativeEngineStatusResponse;
}

interface ModelPlan {
  context: BootstrapContext;
  installedChatModels: Array<{
    id: string;
    name?: string;
    approxSizeBytes?: number;
    attribution?: string;
  }>;
  /** Hardware winner before availability is considered. */
  recommendedChatModel?: BootstrapChatModel;
  /** Downloadable choices, in hardware recommendation order. */
  chatModels: BootstrapChatModel[];
  accessories: BootstrapAccessoryModel[];
}

interface ProgressState {
  title: string;
  detail: string;
  current: number;
  total: number;
  pct: number | null;
}

type Screen =
  | { kind: 'loading'; message: string }
  | {
      kind: 'native-choice';
      context: BootstrapContext;
      missing: NativeEngineName[];
    }
  | { kind: 'model-choice'; plan: ModelPlan }
  | { kind: 'installing'; progress: ProgressState }
  | { kind: 'error'; title: string; message: string; retry?: () => void }
  | { kind: 'ready' };

type ModelChoice =
  | { kind: 'bundle'; model: BootstrapChatModel }
  | { kind: 'chat'; model: BootstrapChatModel }
  | { kind: 'installed'; modelId: string }
  | { kind: 'skip' };

const MAX_ALTERNATIVE_MODELS = 6;

/**
 * First-run TUI setup. It only intervenes for the local providers selected by
 * the daemon's device bootstrap; configured cloud/external-engine users pass
 * straight through.
 */
export function BootstrapGate(props: {
  client: GezelClient;
  children: ReactNode;
}): JSX.Element {
  const { client, children } = props;
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>({
    kind: 'loading',
    message: 'Checking this device…',
  });

  useInput(
    (input, key) => {
      if (key.ctrl && input.toLowerCase() === 'c') exit();
    },
    // Once setup hands control to App, App owns Ctrl+C's interrupt/exit
    // contract. Leaving this handler active made the first Ctrl+C exit the
    // entire TUI before App could interrupt an in-flight turn or arm its
    // deliberate second-press exit.
    { isActive: screen.kind !== 'ready' },
  );

  const prepareModels = useCallback(
    async (context: BootstrapContext) => {
      setScreen({ kind: 'loading', message: 'Finding the best models for this device…' });
      const installedChat =
        context.provider === 'mlx'
          ? await client.listMlxModels()
          : await client.listLlamaCppModels();
      const pinnedModel = context.config.defaultModel?.[context.provider];
      if (pinnedModel && installedChat.models.some((model) => model.id === pinnedModel)) {
        setScreen({ kind: 'ready' });
        return;
      }

      const [
        imageCatalog,
        videoCatalog,
        audioCatalog,
        recognitionCatalog,
        installedImage,
        installedVideo,
        installedStt,
        installedTts,
        installedRecognition,
      ] = await Promise.all([
        client.listCatalogItems('image-model').catch(() => ({ items: [] })),
        client.listCatalogItems('video-model').catch(() => ({ items: [] })),
        client.listAudioCatalog().catch(() => ({ stt: [], tts: [] })),
        client.listRecognitionCatalog().catch(() => ({ models: [] })),
        client.listInstalledImageModels().catch(() => ({ models: [] })),
        client.listInstalledVideoModels().catch(() => ({ models: [] })),
        client.listInstalledSttModels().catch(() => ({ models: [] })),
        client.listInstalledTtsModels().catch(() => ({ models: [] })),
        client.listInstalledRecognitionModels().catch(() => ({ models: [] })),
      ]);
      const installedIds = new Set(installedChat.models.map((model) => model.id));
      const rankedChatModels = rankChatModels(
        context.chatCatalog,
        context.device,
        context.provider,
      );
      const recommendedChatModel = rankedChatModels[0];
      const chatModels = rankedChatModels.filter((model) => !installedIds.has(model.id));
      const catalogAttributions = new Map(
        context.chatCatalog.flatMap((item) =>
          item.manifest.kind === 'chat-model'
            ? [[item.manifest.id, formatModelAttribution(item.manifest)] as const]
            : [],
        ),
      );
      if (chatModels.length === 0 && installedChat.models.length === 0) {
        setScreen({
          kind: 'error',
          title: 'No compatible local models found',
          message:
            'The catalog has no open chat model for this device and local engine. You can continue and configure a cloud or external provider.',
        });
        return;
      }
      const accessories = pickAccessoryModels(
        {
          imageItems: imageCatalog.items,
          videoItems: videoCatalog.items,
          audio: audioCatalog,
          recognition: recognitionCatalog.models,
          installed: {
            image: idSet(installedImage.models),
            video: idSet(installedVideo.models),
            stt: idSet(installedStt.models),
            tts: idSet(installedTts.models),
            recognition: idSet(installedRecognition.models),
          },
        },
        context.device,
      );
      setScreen({
        kind: 'model-choice',
        plan: {
          context,
          installedChatModels: installedChat.models.map((model) => {
            const attribution = catalogAttributions.get(model.id);
            return { ...model, ...(attribution ? { attribution } : {}) };
          }),
          ...(recommendedChatModel ? { recommendedChatModel } : {}),
          chatModels,
          accessories,
        },
      });
    },
    [client],
  );

  const initialize = useCallback(async () => {
    try {
      setScreen({ kind: 'loading', message: 'Checking this device…' });
      // Device/catalog work gives the daemon's asynchronous first-run picker a
      // chance to finish before we read config and decide whether local setup
      // applies. A short poll closes the remaining clean-start race.
      const [memory, chatCatalog] = await Promise.all([
        client.getMemoryProfile(),
        client.listCatalogItems('chat-model'),
      ]);
      const config = await settledFirstRunConfig(client);
      if (config.provider !== 'llama-cpp' && config.provider !== 'mlx') {
        setScreen({ kind: 'ready' });
        return;
      }
      if (
        (config.provider === 'llama-cpp' && (config.llamaCppBaseUrl || config.llamaCppModelPath)) ||
        (config.provider === 'mlx' && (config.mlxBaseUrl || config.mlxModelPath))
      ) {
        setScreen({ kind: 'ready' });
        return;
      }
      const nativeStatus = await client.getNativeEngineStatus();
      if (!nativeStatus.platformKey) {
        setScreen({ kind: 'ready' });
        return;
      }
      const context: BootstrapContext = {
        config,
        provider: config.provider,
        device: recoDevice(memory),
        chatCatalog: chatCatalog.items,
        nativeStatus,
      };
      const missing = missingToolkit(nativeStatus);
      if (missing.length > 0) {
        setScreen({ kind: 'native-choice', context, missing });
      } else {
        await prepareModels(context);
      }
    } catch (error) {
      setScreen({
        kind: 'error',
        title: 'Setup check failed',
        message: errorMessage(error),
        retry: () => void initialize(),
      });
    }
  }, [client, prepareModels]);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  const installNative = useCallback(
    async (context: BootstrapContext, missing: NativeEngineName[]) => {
      const retry = () => void installNative(context, missing);
      if (!context.nativeStatus.pinned) {
        setScreen({
          kind: 'error',
          title: 'Native downloads are unavailable',
          message:
            'This CLI build does not carry a verified native release pin. Install a published @bendyline/gezel-cli build or configure external engines.',
        });
        return;
      }
      try {
        await installNativeToolkit(client, context.nativeStatus, missing, setScreen);
        // The first memory snapshot was taken before llama-server existed, so
        // an AMD/Intel Vulkan host looked CPU-only and fell into the E2B
        // safety floor. Re-probe after the resolver stamps the binary path;
        // recommendation must use the dGPU the freshly-installed engine sees.
        const [nativeStatus, memory] = await Promise.all([
          client.getNativeEngineStatus(),
          client.getMemoryProfile(),
        ]);
        await prepareModels({
          ...context,
          nativeStatus,
          device: recoDevice(memory),
        });
      } catch (error) {
        setScreen({
          kind: 'error',
          title: 'Gezel native toolkit install failed',
          message: errorMessage(error),
          retry,
        });
      }
    },
    [client, prepareModels],
  );

  const installModels = useCallback(
    async (plan: ModelPlan, choice: ModelChoice) => {
      if (choice.kind === 'skip') {
        setScreen({ kind: 'ready' });
        return;
      }
      const retry = () => void installModels(plan, choice);
      try {
        if (choice.kind === 'installed') {
          const updated = await client.updateConfig({
            provider: plan.context.provider,
            defaultModel: {
              ...plan.context.config.defaultModel,
              [plan.context.provider]: choice.modelId,
            },
            firstRunInstallError: null,
          });
          plan.context.config = updated;
          setScreen({ kind: 'ready' });
          return;
        }
        if (choice.kind === 'bundle') {
          const missing = missingToolkit(await client.getNativeEngineStatus());
          if (missing.length > 0) {
            await installNativeToolkit(client, plan.context.nativeStatus, missing, setScreen);
          }
        }
        const chatAlreadyInstalled =
          choice.kind === 'bundle' &&
          plan.installedChatModels.some((model) => model.id === choice.model.id);
        const jobs = [
          ...(!chatAlreadyInstalled
            ? [{ label: choice.model.name, sizeBytes: choice.model.approxSizeBytes }]
            : []),
          ...(choice.kind === 'bundle'
            ? plan.accessories.map((model) => ({
                label: model.name,
                sizeBytes: model.approxSizeBytes,
              }))
            : []),
        ];
        let jobIndex = 0;
        if (!chatAlreadyInstalled) {
          await installChatModel(client, choice.model, (event) => {
            updateDownloadProgress(setScreen, jobs[jobIndex]!, jobIndex, jobs.length, event);
          });
          jobIndex += 1;
        }
        const updated = await client.updateConfig({
          provider: choice.model.provider,
          defaultModel: {
            ...plan.context.config.defaultModel,
            [choice.model.provider]: choice.model.id,
          },
          // The successful interactive install supersedes an earlier banner error.
          firstRunInstallError: null,
        });
        plan.context.config = updated;

        if (choice.kind === 'bundle') {
          for (const accessory of plan.accessories) {
            await installAccessory(client, accessory, (event) => {
              updateDownloadProgress(setScreen, jobs[jobIndex]!, jobIndex, jobs.length, event);
            });
            jobIndex += 1;
          }
        }
        setScreen({ kind: 'ready' });
      } catch (error) {
        setScreen({
          kind: 'error',
          title: 'Model install failed',
          message: errorMessage(error),
          retry,
        });
      }
    },
    [client],
  );

  if (screen.kind === 'ready') return <>{children}</>;
  if (screen.kind === 'loading') {
    return (
      <BootstrapFrame title="Preparing the workshop">
        <Text color="yellow">● {screen.message}</Text>
      </BootstrapFrame>
    );
  }
  if (screen.kind === 'installing') {
    return (
      <BootstrapFrame title={screen.progress.title}>
        <Text>
          {screen.progress.current}/{screen.progress.total} {screen.progress.detail}
        </Text>
        <ProgressBar pct={screen.progress.pct} />
        <Text dimColor>{screen.progress.pct == null ? 'Working…' : `${screen.progress.pct}%`}</Text>
      </BootstrapFrame>
    );
  }
  if (screen.kind === 'native-choice') {
    const labels = screen.missing.map(nativeLabel).join(', ');
    return (
      <BootstrapFrame title="The Gezel native toolkit -- needed to run AI models locally -- is not installed yet">
        <Text>{`Gezel can install the verified Gezel native toolkit (native-v${screen.context.nativeStatus.release}) for this device.`}</Text>
        <Text>
          Downloaded from{' '}
          <Text bold color="cyan">
            https://github.com/bendyline/gezel/releases/
          </Text>
        </Text>
        <Text dimColor>Missing: {labels}</Text>
        <BootstrapChoiceList
          options={[
            {
              label: 'Install the Gezel native toolkit',
              hint: 'recommended · engines for chat, images, speech, and local model helpers',
              value: 'install',
            },
            { label: 'Not now', hint: 'continue to model choices', value: 'skip' },
          ]}
          onSelect={(value) => {
            if (value === 'install') {
              void installNative(screen.context, screen.missing);
            } else {
              void prepareModels(screen.context);
            }
          }}
        />
      </BootstrapFrame>
    );
  }
  if (screen.kind === 'model-choice') {
    const best = screen.plan.recommendedChatModel;
    const bestInstalled = best
      ? screen.plan.installedChatModels.some((model) => model.id === best.id)
      : false;
    const accessoryBytes = screen.plan.accessories.reduce(
      (sum, model) => sum + model.approxSizeBytes,
      0,
    );
    const workshopDownloadBytes =
      accessoryBytes + (best && !bestInstalled ? best.approxSizeBytes : 0);
    const options = [
      ...(best
        ? [
            {
              label: `Recommended workshop set — ${bootstrapChatModelLabel(best)} + ${screen.plan.accessories.length} helpers`,
              hint: `${bestInstalled ? 'chat model already available · ' : ''}${
                workshopDownloadBytes > 0
                  ? formatDownloadSize(workshopDownloadBytes)
                  : 'already available'
              }`,
              value: 'bundle',
            },
            {
              label: `${bestInstalled ? 'Use' : 'Download'} ${bootstrapChatModelLabel(best)} only`,
              hint: `recommended for this device · ${
                bestInstalled ? 'already available' : formatDownloadSize(best.approxSizeBytes)
              }`,
              value: bestInstalled ? `installed:${best.id}` : `chat:${best.id}`,
            },
          ]
        : []),
      ...screen.plan.installedChatModels
        .filter((model) => model.id !== best?.id)
        .map((model) => ({
          label: `Use ${model.name ?? model.id}${model.attribution ? ` (${model.attribution})` : ''}`,
          hint: `already available on this machine${
            model.approxSizeBytes ? ` · ${formatDownloadSize(model.approxSizeBytes)}` : ''
          }`,
          value: `installed:${model.id}`,
        })),
      ...screen.plan.chatModels
        .filter((model) => model.id !== best?.id)
        .slice(0, MAX_ALTERNATIVE_MODELS)
        .map((model) => ({
          label: `Download ${bootstrapChatModelLabel(model)} only`,
          hint: `${formatDownloadSize(model.approxSizeBytes)} · ${fitLabel(model.fit)}`,
          value: `chat:${model.id}`,
        })),
      { label: 'Not now', hint: 'open the TUI without a local model', value: 'skip' },
    ];
    return (
      <BootstrapFrame
        title={
          screen.plan.installedChatModels.length > 0
            ? 'Choose a local chat model'
            : 'No local chat model is installed'
        }
      >
        <Text>
          {screen.plan.installedChatModels.length > 0
            ? 'These models are already available in your Gezel or shared machine store. You can use one now or download another.'
            : 'Pick a setup for this device. Downloads stay under Gezel model storage.'}
        </Text>
        <BootstrapChoiceList
          options={options}
          onSelect={(value) => {
            if (value === 'skip') {
              void installModels(screen.plan, { kind: 'skip' });
            } else if (value === 'bundle') {
              if (best) void installModels(screen.plan, { kind: 'bundle', model: best });
            } else if (value.startsWith('installed:')) {
              void installModels(screen.plan, {
                kind: 'installed',
                modelId: value.slice('installed:'.length),
              });
            } else {
              const id = value.slice('chat:'.length);
              const model = screen.plan.chatModels.find((candidate) => candidate.id === id);
              if (model) void installModels(screen.plan, { kind: 'chat', model });
            }
          }}
        />
      </BootstrapFrame>
    );
  }
  return (
    <BootstrapFrame title={screen.title}>
      <Text color="red">{screen.message}</Text>
      <BootstrapChoiceList
        options={[
          ...(screen.retry ? [{ label: 'Try again', hint: 'resume setup', value: 'retry' }] : []),
          { label: 'Continue to Gezel', hint: 'configure this later', value: 'continue' },
        ]}
        onSelect={(value) => {
          if (value === 'retry') screen.retry?.();
          else setScreen({ kind: 'ready' });
        }}
      />
    </BootstrapFrame>
  );
}

function BootstrapFrame(props: { title: string; children: ReactNode }): JSX.Element {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold color="cyan">
        gezel · first-time setup
      </Text>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="yellow"
        paddingX={1}
        marginTop={1}
      >
        <Text bold color="yellow">
          {props.title}
        </Text>
        {props.children}
      </Box>
      <Text dimColor>Ctrl+C exit</Text>
    </Box>
  );
}

function recoDevice(memory: Awaited<ReturnType<GezelClient['getMemoryProfile']>>): RecoDevice {
  return {
    platform: memory.platform,
    gpuVramBytes: memory.gpuVramBytes,
    ...(memory.gpuMemoryKind ? { gpuMemoryKind: memory.gpuMemoryKind } : {}),
    totalRamBytes: memory.totalRamBytes,
    usableBytes: memory.usableBytes,
    ...(memory.budgetBytes !== undefined ? { budgetBytes: memory.budgetBytes } : {}),
  };
}

function BootstrapChoiceList(props: {
  options: ReadonlyArray<{ label: string; hint?: string; value: string }>;
  onSelect: (value: string) => void;
}): JSX.Element {
  const [index, setIndex] = useState(0);
  const options = props.options;
  useInput((input, key) => {
    if (key.upArrow) {
      setIndex((current) => (current <= 0 ? options.length - 1 : current - 1));
      return;
    }
    if (key.downArrow) {
      setIndex((current) => (current >= options.length - 1 ? 0 : current + 1));
      return;
    }
    const numeric = Number.parseInt(input, 10);
    if (/^[1-9]$/.test(input) && numeric <= options.length) {
      props.onSelect(options[numeric - 1]!.value);
      return;
    }
    if (key.return) {
      const selected = options[index];
      if (selected) props.onSelect(selected.value);
    }
  });
  return (
    <Box flexDirection="column" marginTop={1}>
      {options.map((option, optionIndex) => (
        <Text key={option.value} color={optionIndex === index ? 'green' : undefined}>
          {optionIndex === index ? '❯ ' : '  '}
          {optionIndex + 1}. {option.label}
          {option.hint ? <Text dimColor> — {option.hint}</Text> : null}
        </Text>
      ))}
      <Text dimColor>
        ↑/↓ choose · 1–{Math.min(9, options.length)} quick select · Enter confirm
      </Text>
    </Box>
  );
}

function ProgressBar({ pct }: { pct: number | null }): JSX.Element {
  const width = 36;
  const filled = pct == null ? 0 : Math.round((Math.max(0, Math.min(100, pct)) / 100) * width);
  return (
    <Text color="yellow">
      [{pct == null ? '·'.repeat(width) : `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`}]
    </Text>
  );
}

async function settledFirstRunConfig(client: GezelClient): Promise<ConfigResponse> {
  let config = await client.getConfig();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (config.firstRunCompleted || config.provider !== 'copilot') return config;
    await delay(250);
    config = await client.getConfig();
  }
  return config;
}

async function installNativeToolkit(
  client: GezelClient,
  status: NativeEngineStatusResponse,
  missing: readonly NativeEngineName[],
  setScreen: (screen: Screen) => void,
): Promise<void> {
  for (let index = 0; index < missing.length; index += 1) {
    const engine = missing[index]!;
    let terminalError: string | null = null;
    await client.ensureNativeEngine(
      engine,
      (event) => {
        if (event.type === 'error') terminalError = event.error;
        updateDownloadProgress(
          setScreen,
          { label: nativeLabel(engine), sizeBytes: 0 },
          index,
          missing.length,
          event,
          `Installing the Gezel native toolkit (native-v${status.release})`,
        );
      },
      engine === 'llama-server' ? status.llamaBackend : undefined,
    );
    if (terminalError) throw new Error(terminalError);
  }
}

async function installChatModel(
  client: GezelClient,
  model: BootstrapChatModel,
  onEvent: (event: DownloadEvent) => void,
): Promise<void> {
  let terminalError: string | null = null;
  const listener = (event: LlamaCppInstallEvent | MlxInstallEvent) => {
    if (event.type === 'error') terminalError = event.error;
    onEvent(event);
  };
  if (model.provider === 'mlx') {
    await client.installMlxModel(model.id, listener);
  } else {
    await client.installLlamaCppModel(model.id, listener);
  }
  if (terminalError) throw new Error(terminalError);
}

async function installAccessory(
  client: GezelClient,
  model: BootstrapAccessoryModel,
  onEvent: (event: DownloadEvent) => void,
): Promise<void> {
  let terminalError: string | null = null;
  const listener = (event: DownloadEvent) => {
    if (event.type === 'error') terminalError = event.error ?? 'download failed';
    onEvent(event);
  };
  if (model.kind === 'image') {
    await client.pullImageModel(model.id, listener);
  } else if (model.kind === 'video') {
    await client.pullVideoModel(model.id, listener);
  } else if (model.kind === 'recognition') {
    await client.pullRecognitionModel(model.id, listener);
  } else {
    await client.pullAudioModel(model.kind, model.id, listener);
  }
  if (terminalError) throw new Error(terminalError);
}

function updateDownloadProgress(
  setScreen: (screen: Screen) => void,
  job: { label: string; sizeBytes: number },
  index: number,
  total: number,
  event: DownloadEvent,
  title = 'Installing local models',
): void {
  let pct: number | null = null;
  let detail = job.label;
  if (event.type === 'progress') {
    const written =
      'bytesWrittenAll' in event && typeof event.bytesWrittenAll === 'number'
        ? event.bytesWrittenAll
        : event.bytesWritten;
    const all =
      'totalBytesAll' in event && typeof event.totalBytesAll === 'number'
        ? event.totalBytesAll
        : event.totalBytes;
    if (typeof written === 'number' && typeof all === 'number' && all > 0) {
      pct = Math.min(100, Math.floor((written / all) * 100));
      detail = `${job.label} · ${formatDownloadSize(written)} of ${formatDownloadSize(all)}`;
    }
  } else if (event.type === 'retrying' && 'attempt' in event) {
    detail = `${job.label} · retrying ${event.attempt}/${event.maxAttempts}`;
  } else if (event.type === 'verifying') {
    detail = `${job.label} · verifying`;
  } else if (event.type === 'done') {
    pct = 100;
    detail = `${job.label} · ready`;
  }
  setScreen({
    kind: 'installing',
    progress: {
      title,
      detail,
      current: index + 1,
      total,
      pct,
    },
  });
}

function missingToolkit(status: NativeEngineStatusResponse): NativeEngineName[] {
  const installed = new Set(
    status.engines.filter((engine) => engine.installed).map((engine) => engine.name),
  );
  return NATIVE_TOOLKIT.filter((engine) => !installed.has(engine));
}

function idSet(models: ReadonlyArray<{ id: string }>): Set<string> {
  return new Set(models.map((model) => model.id));
}

function nativeLabel(engine: NativeEngineName): string {
  switch (engine) {
    case 'llama-server':
      return 'llama';
    case 'sd-server':
      return 'image engine';
    case 'whisper-server':
      return 'speech engine';
    case 'uv':
      return 'local runtime helper';
    case 'ds4-server':
      return 'ds4';
  }
}

function fitLabel(fit: BootstrapChatModel['fit']): string {
  if (fit === 'fits-offload') return 'fits with offload';
  if (fit === 'fits') return 'good fit';
  if (fit === 'tight') return 'tight fit';
  return 'best available';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
