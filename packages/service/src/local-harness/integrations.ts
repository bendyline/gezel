import type { CatalogService } from '@bendyline/gezel-catalog';
import type { serve } from '@hono/node-server';
import type { ChatManager } from '../chat/manager.js';
import { type CodexSetupManager, createCodexSetupManager } from '../codex-setup/manager.js';
import type { Store } from '../fs/store.js';
import { buildCodexBridgeApp, createCodexBridgeController } from '../http/codex-bridge.js';
import type { ServiceContext } from '../http/context.js';
import {
  codexBridgePortForHome,
  opencodeBridgePortForHome,
  piBridgePortForHome,
  vscodeBridgePortForHome,
} from '../http/local-bridge-port.js';
import { buildOpenCodeBridgeApp, createOpenCodeBridgeController } from '../http/opencode-bridge.js';
import { buildPiBridgeApp, createPiBridgeController } from '../http/pi-bridge.js';
import type { TokenStore } from '../http/token-store.js';
import { buildVSCodeBridgeApp, createVSCodeBridgeController } from '../http/vscode-bridge.js';
import {
  type OpenCodeSetupManager,
  createOpenCodeSetupManager,
} from '../opencode-setup/manager.js';
import { type PiSetupManager, createPiSetupManager } from '../pi-setup/manager.js';
import type { StartServiceOptions } from '../service-options.js';
import { type VSCodeSetupManager, createVSCodeSetupManager } from '../vscode-setup/manager.js';
import { createLocalHarnessModelSource } from './model-source.js';

/**
 * The daemon's half of the Codex, OpenCode, pi and VS Code integrations,
 * wired as one unit: each harness gets its own stable plain-HTTP bridge and
 * setup manager, and all four publish the same proven-capability model list.
 */
export interface LocalHarnessIntegrations {
  codexSetup: CodexSetupManager;
  opencodeSetup: OpenCodeSetupManager;
  piSetup: PiSetupManager;
  vscodeSetup: VSCodeSetupManager;
  /** Hand each bridge its app once the HTTP context exists; the listeners start later. */
  bindApps(context: ServiceContext): void;
}

export function createLocalHarnessIntegrations(deps: {
  home: string;
  opts: Pick<
    StartServiceOptions,
    | 'codexHome'
    | 'codexBridgePort'
    | 'opencodeBridgePort'
    | 'piBridgePort'
    | 'piAgentDir'
    | 'vscodeBridgePort'
    | 'vscodeUserDir'
  >;
  store: Store;
  chat: ChatManager;
  catalog: CatalogService;
  tokenStore: TokenStore;
  resolveMachineEngineRemoteId: () => string | null;
}): LocalHarnessIntegrations {
  const { home, opts, store, chat, catalog, tokenStore, resolveMachineEngineRemoteId } = deps;

  // Codex needs a stable plain-HTTP origin because the product daemon's port
  // and self-signed certificate rotate. Unlike Ollama emulation this listener
  // remains bearer-authenticated and exposes only inference. Its profile/file
  // manager decides whether it should be running.
  const codexBridgeFetchRef: { value?: Parameters<typeof serve>[0]['fetch'] } = {};
  const codexBridge = createCodexBridgeController({
    fetch: () => {
      if (!codexBridgeFetchRef.value) {
        throw new Error('Codex bridge cannot start before the HTTP app is ready');
      }
      return codexBridgeFetchRef.value;
    },
    port: opts.codexBridgePort ?? codexBridgePortForHome(home),
  });
  const listCodexSetupModels = createLocalHarnessModelSource({
    catalog,
    listModels: (provider, signal) => chat.listModelsForProvider(provider, signal),
    resolveNativeContextWindow: async (provider, modelId, signal) => {
      if (resolveMachineEngineRemoteId()) {
        const remoteProvider = await chat.getProviderForModel(provider, modelId);
        return (
          (await remoteProvider.prepareContextWindow?.(modelId, signal)) ??
          remoteProvider.getContextWindow?.()
        );
      }
      // Standalone, because this number is published to a Codex profile on
      // disk and read back on every launch for days. Live pricing charged the
      // model for whatever else was resident at setup time, so every entry
      // came out at the 64K floor even on a host admitting 128K+ — Codex then
      // compacted at 90% of the wrong figure, repeatedly, mid-task.
      return chat.previewContextWindowForModel(provider, modelId, { standalone: true });
    },
  });
  const codexSetup = createCodexSetupManager({
    home,
    ...(opts.codexHome !== undefined ? { codexHome: opts.codexHome } : {}),
    tokenStore,
    bridge: codexBridge,
    readConfig: () => store.readConfig(),
    listGezels: () => store.listGezels(),
    providerForGezel: (gezelId) => chat.providerForGezel(gezelId),
    listModels: listCodexSetupModels,
  });

  // OpenCode needs the same stable plain-HTTP origin as Codex, on its own port
  // so neither integration's lifecycle can take the other's listener down. Its
  // provider speaks chat completions rather than the Responses API, hence a
  // separate app over the same authenticated route stack.
  const opencodeBridgeFetchRef: { value?: Parameters<typeof serve>[0]['fetch'] } = {};
  const opencodeBridge = createOpenCodeBridgeController({
    fetch: () => {
      if (!opencodeBridgeFetchRef.value) {
        throw new Error('OpenCode bridge cannot start before the HTTP app is ready');
      }
      return opencodeBridgeFetchRef.value;
    },
    port: opts.opencodeBridgePort ?? opencodeBridgePortForHome(home),
  });
  const opencodeSetup = createOpenCodeSetupManager({
    home,
    tokenStore,
    bridge: opencodeBridge,
    readConfig: () => store.readConfig(),
    listGezels: () => store.listGezels(),
    providerForGezel: (gezelId) => chat.providerForGezel(gezelId),
    // The same proven-capability model source Codex uses: a coding harness
    // cannot fall back gracefully from a model that turns out not to do tools.
    listModels: listCodexSetupModels,
  });

  // pi speaks the same chat-completions dialect as OpenCode, on its own port
  // and credential so revoking one harness never disturbs the others.
  const piBridgeFetchRef: { value?: Parameters<typeof serve>[0]['fetch'] } = {};
  const piBridge = createPiBridgeController({
    fetch: () => {
      if (!piBridgeFetchRef.value) {
        throw new Error('pi bridge cannot start before the HTTP app is ready');
      }
      return piBridgeFetchRef.value;
    },
    port: opts.piBridgePort ?? piBridgePortForHome(home),
  });
  const piSetup = createPiSetupManager({
    home,
    ...(opts.piAgentDir !== undefined ? { piAgentDir: opts.piAgentDir } : {}),
    tokenStore,
    bridge: piBridge,
    readConfig: () => store.readConfig(),
    listGezels: () => store.listGezels(),
    providerForGezel: (gezelId) => chat.providerForGezel(gezelId),
    listModels: listCodexSetupModels,
  });

  // VS Code's built-in custom-endpoint provider uses chat completions too.
  // It gets an independent port and credential so its plaintext profile token
  // can be revoked without disturbing any other connected app.
  const vscodeBridgeFetchRef: { value?: Parameters<typeof serve>[0]['fetch'] } = {};
  const vscodeBridge = createVSCodeBridgeController({
    fetch: () => {
      if (!vscodeBridgeFetchRef.value) {
        throw new Error('VS Code bridge cannot start before the HTTP app is ready');
      }
      return vscodeBridgeFetchRef.value;
    },
    port: opts.vscodeBridgePort ?? vscodeBridgePortForHome(home),
  });
  const vscodeSetup = createVSCodeSetupManager({
    home,
    ...(opts.vscodeUserDir !== undefined ? { vscodeUserDir: opts.vscodeUserDir } : {}),
    tokenStore,
    bridge: vscodeBridge,
    readConfig: () => store.readConfig(),
    listGezels: () => store.listGezels(),
    providerForGezel: (gezelId) => chat.providerForGezel(gezelId),
    listModels: listCodexSetupModels,
  });

  return {
    codexSetup,
    opencodeSetup,
    piSetup,
    vscodeSetup,
    bindApps(context) {
      const codexBridgeApp = buildCodexBridgeApp(context, {
        models: () => codexSetup.codexModelCatalog(),
      });
      codexBridgeFetchRef.value = codexBridgeApp.fetch.bind(codexBridgeApp);
      const opencodeBridgeApp = buildOpenCodeBridgeApp(context);
      opencodeBridgeFetchRef.value = opencodeBridgeApp.fetch.bind(opencodeBridgeApp);
      const piBridgeApp = buildPiBridgeApp(context);
      piBridgeFetchRef.value = piBridgeApp.fetch.bind(piBridgeApp);
      const vscodeBridgeApp = buildVSCodeBridgeApp(context);
      vscodeBridgeFetchRef.value = vscodeBridgeApp.fetch.bind(vscodeBridgeApp);
    },
  };
}
