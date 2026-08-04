import type { GezelClient } from '@bendyline/gezel-client/node';
import * as vscode from 'vscode';
import { ChatViewProvider } from './chat-view.js';
import { OPEN_FILE_COMMAND } from './code-intel-core.js';
import { registerCodeIntel } from './code-intel.js';
import { registerCommands } from './commands.js';
import { readConfig } from './config.js';
import { type AppConnection, type Connection, acquireAppConnection } from './daemon.js';
import { GezelLanguageModelProvider } from './lm-provider.js';
import { createLogger } from './log.js';
import { WebviewRpc } from './webview-rpc.js';
import { ensureDevGezel, ensureProjectForWorkspace } from './workspace.js';

interface ExtensionState {
  connection: Connection | null;
  activeFolder: vscode.WorkspaceFolder | null;
  activeProjectId: string | null;
  activeGezel: { id: string; name: string } | null;
  /** projectId cache keyed by workspace folder URI string. */
  projectCache: Map<string, string>;
  /** Disposable registered with vscode.lm for the LM Chat Provider. */
  lmProviderDisposable: vscode.Disposable | null;
  /** Active LM provider instance — kept so we can dispose its background timer. */
  lmProvider: GezelLanguageModelProvider | null;
  /**
   * Last failure observed in the connect/LM-provider pipeline. Surfaced
   * by the `Gezel: Show Status` command and via a one-time error toast
   * on activation so the user doesn't have to dig through Output to
   * see what broke.
   */
  lastError: { stage: 'connect' | 'lm-provider'; message: string } | null;
  /**
   * Host-owned reconnect handle, populated by `activate()` after the
   * local `reconnect` function is defined. Passed down to the LM
   * provider so it can recover from a "daemon restarted, undici
   * dispatcher is stale" failure mid-conversation. Optional because
   * cold-start state construction runs before `reconnect` is
   * available — readers must null-check.
   */
  reconnect: (() => Promise<void>) | null;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = createLogger();
  context.subscriptions.push({ dispose: () => logger.dispose() });
  logger.info('activating @bendyline/gezel-vscode');

  const view = new ChatViewProvider(context.extensionUri, logger);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const state: ExtensionState = {
    connection: null,
    activeFolder: vscode.workspace.workspaceFolders?.[0] ?? null,
    activeProjectId: null,
    activeGezel: null,
    projectCache: new Map(),
    lmProviderDisposable: null,
    lmProvider: null,
    lastError: null,
    // Filled in below once `reconnect` is defined — the function
    // closes over `state`, so we can't construct it before the
    // state object exists.
    reconnect: null,
  };

  // Bridge for the webview's postMessage-RPC fetch. The chat bundle
  // routes every daemon call through here so it can ride the
  // extension host's TLS-trusting undici instead of hitting the cert
  // guard that blocks the webview's direct fetch. See webview-rpc.ts
  // for the protocol; the webview side lives at packages/vscode/
  // webview/bridge.ts.
  const rpc = new WebviewRpc(view, () => state.connection, logger);
  context.subscriptions.push(
    view.onMessage((msg) => {
      if (msg.type === 'fetch-request') {
        void rpc.handleRequest(msg);
      } else if (msg.type === 'fetch-abort') {
        rpc.handleAbort(msg);
      } else if (msg.type === 'open-file') {
        void vscode.commands
          .executeCommand(OPEN_FILE_COMMAND, {
            path: msg.path,
            ...(msg.line !== undefined ? { line: msg.line } : {}),
          })
          .then(undefined, (err: unknown) => {
            logger.warn(
              `couldn't open ${msg.path}: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }
    }),
  );

  context.subscriptions.push({
    dispose: () => {
      state.lmProvider?.dispose();
      state.lmProviderDisposable?.dispose();
    },
  });

  const setActiveFolder = async (folder: vscode.WorkspaceFolder): Promise<void> => {
    state.activeFolder = folder;
    if (state.connection) {
      await rewireProject(state, state.connection.client, logger);
      view.post({
        type: 'project-changed',
        projectId: state.activeProjectId,
        workingDir: folder.uri.fsPath,
      });
    }
  };

  const setActiveGezel = (g: { id: string; name: string }): void => {
    state.activeGezel = g;
    view.post({ type: 'gezel-changed', gezelId: g.id, gezelName: g.name });
  };

  const reconnect = async (): Promise<void> => {
    state.connection = null;
    state.activeProjectId = null;
    state.projectCache.clear();
    state.lmProvider?.dispose();
    state.lmProviderDisposable?.dispose();
    state.lmProvider = null;
    state.lmProviderDisposable = null;
    await connect(state, view, context, logger);
  };
  // Now that `reconnect` exists, hand the LM provider the same handle
  // so it can fire it when undici reports a fetch-layer failure.
  state.reconnect = reconnect;

  context.subscriptions.push(
    ...registerCommands({
      view,
      getClient: () => state.connection?.client ?? null,
      getConnection: () => state.connection,
      getActiveGezel: () => state.activeGezel,
      setActiveGezel,
      getActiveFolder: () => state.activeFolder,
      setActiveFolder,
      reconnect,
      logger,
      getStatus: () => buildStatusReport(state),
      clearAppTokenSecret: async () => {
        await context.secrets.delete('gezel:vscode');
      },
    }),
  );

  // Per-symbol context in real editors (CodeLens + hover), fed by the same
  // file-context endpoint + composer as the desktop app's Map file viewer.
  context.subscriptions.push(
    registerCodeIntel({
      getConnection: () => state.connection,
      getActiveFolder: () => state.activeFolder,
      getActiveProjectId: () => state.activeProjectId,
      logger,
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async (e) => {
      for (const removed of e.removed) {
        state.projectCache.delete(removed.uri.toString());
        if (state.activeFolder?.uri.toString() === removed.uri.toString()) {
          state.activeFolder = vscode.workspace.workspaceFolders?.[0] ?? null;
          if (state.activeFolder && state.connection) {
            await rewireProject(state, state.connection.client, logger);
            view.post({
              type: 'project-changed',
              projectId: state.activeProjectId,
              workingDir: state.activeFolder.uri.fsPath,
            });
          }
        }
      }
      // Added folders are handled lazily — the user has to switch to them
      // via gezel.switchFolder before we ensure a project. Pre-ensuring
      // would create projects the user may not want yet.
    }),
  );

  // Connect in background so activation doesn't block VSCode startup.
  void connect(state, view, context, logger);
}

export function deactivate(): void {
  // Disposables are cleaned up by VSCode via the context.subscriptions list.
}

async function connect(
  state: ExtensionState,
  view: ChatViewProvider,
  context: vscode.ExtensionContext,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  state.lastError = null;
  try {
    const cfg = readConfig();
    const appConnection = await acquireVerifiedExtensionAccess(cfg, context, logger);
    const conn = appConnection.connection;
    state.connection = conn;
    const gezel = await ensureDevGezel(conn.client, cfg.defaultGezel, logger);
    state.activeGezel = gezel;
    await rewireProject(state, conn.client, logger);
    view.post({
      type: 'connection-ready',
      baseUrl: conn.baseUrl,
      projectId: state.activeProjectId,
      gezelId: gezel.id,
      workingDir: state.activeFolder?.uri.fsPath ?? null,
      mode: conn.mode,
    });
    logger.info(
      `ready — gezel=${gezel.name} project=${state.activeProjectId ?? 'none'} mode=${conn.mode}`,
    );

    if (lmProviderEnabled()) {
      logger.info('lm-provider: enabled by setting; starting registration...');
      try {
        await ensureLanguageModelProvider(state, conn, appConnection, logger);
      } catch (err) {
        // LM Chat Provider is additive — its failure must not break
        // the rest of the extension's chat panel. Surface explicitly
        // so the user sees it instead of silently missing models.
        const message = err instanceof Error ? err.message : String(err);
        state.lastError = { stage: 'lm-provider', message };
        logger.warn(`Language Model Chat Provider not registered: ${message}`);
        // `already_connected` means the daemon has a token for the
        // `vscode` appId but VS Code's secrets store doesn't have the
        // matching string. A third-party client cannot revoke an unknown
        // token; the user must remove it in Gezel's Connected Apps settings.
        const alreadyConnected = /already_connected/i.test(message);
        const actions = ['Show Logs', 'Show Status'] as const;
        void vscode.window
          .showWarningMessage(
            alreadyConnected
              ? 'Gezel: Visual Studio Code is already authorized, but its local token is missing. Revoke Visual Studio Code in Gezel Settings → Connected Apps, then reconnect.'
              : `Gezel: language models not registered — ${message}`,
            ...actions,
          )
          .then((pick) => {
            if (pick === 'Show Logs') void vscode.commands.executeCommand('gezel.showLogs');
            else if (pick === 'Show Status')
              void vscode.commands.executeCommand('gezel.showStatus');
          });
      }
    } else {
      logger.info(
        'lm-provider: DISABLED by gezel.languageModelProvider.enabled setting — set to true to register gezels as language models',
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.lastError = { stage: 'connect', message };
    logger.error(`connect failed: ${message}`);
    view.post({ type: 'connection-error', message, retryable: true });
    const alreadyConnected = /already_connected/i.test(message);
    const actions = alreadyConnected
      ? (['Show Logs', 'Show Status'] as const)
      : (['Show Logs', 'Show Status', 'Reconnect'] as const);
    void vscode.window
      .showErrorMessage(
        alreadyConnected
          ? 'Gezel: Visual Studio Code is already authorized, but its local token is missing. Revoke Visual Studio Code in Gezel Settings → Connected Apps, then reconnect.'
          : `Gezel: couldn't connect — ${message}`,
        ...actions,
      )
      .then((pick) => {
        if (pick === 'Show Logs') void vscode.commands.executeCommand('gezel.showLogs');
        else if (pick === 'Show Status') void vscode.commands.executeCommand('gezel.showStatus');
        else if (pick === 'Reconnect') void vscode.commands.executeCommand('gezel.refresh');
      });
  }
}

function lmProviderEnabled(): boolean {
  const cfg = vscode.workspace.getConfiguration('gezel');
  return cfg.get<boolean>('languageModelProvider.enabled', true);
}

async function ensureLanguageModelProvider(
  state: ExtensionState,
  conn: Connection,
  appConnection: AppConnection,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  // Authorization already happened for the complete extension before the
  // embedded product UX was allowed to boot. Reuse that same app identity
  // here rather than filing a second, inference-only grant.
  logger.info('lm-provider: instantiating provider from the extension app grant...');
  const provider = new GezelLanguageModelProvider(
    appConnection.app,
    conn.baseUrl,
    appConnection.appToken,
    conn.fetch,
    logger,
    // Reconnect handle — see ExtensionState.reconnect. Wrapped
    // in a closure so the provider always reaches the current
    // `state.reconnect` (vs capturing the value at construction
    // time, which would let a torn-down callback persist if the
    // provider outlived a reconnect).
    () => state.reconnect?.() ?? Promise.resolve(),
  );
  state.lmProvider = provider;
  logger.info('lm-provider: calling vscode.lm.registerLanguageModelChatProvider...');
  state.lmProviderDisposable = vscode.lm.registerLanguageModelChatProvider('gezel', provider);
  logger.info('lm-provider: registered (vendor=gezel) — gezel models should appear in pickers');
}

async function acquireVerifiedExtensionAccess(
  config: ReturnType<typeof readConfig>,
  context: vscode.ExtensionContext,
  logger: ReturnType<typeof createLogger>,
): Promise<AppConnection> {
  const stillWaiting = { value: true };
  const verificationCodeShown = { value: false };
  const waitToastTimer = setTimeout(() => {
    if (!stillWaiting.value || verificationCodeShown.value) return;
    void vscode.window
      .showInformationMessage(
        'Gezel: waiting to start the authorization request. Keep the Gezel desktop app open.',
        'Show Logs',
      )
      .then((pick) => {
        if (!stillWaiting.value) return;
        if (pick === 'Show Logs') {
          void vscode.commands.executeCommand('gezel.showLogs');
        }
      });
  }, 1500);

  try {
    logger.info('authorization: requesting product + inference access through the app SDK...');
    return await acquireAppConnection(config, context, logger, async (code) => {
      verificationCodeShown.value = true;
      clearTimeout(waitToastTimer);
      logger.info('authorization: daemon issued a requester-side connection code');
      const action = await vscode.window.showInformationMessage(
        `Gezel connection code: ${code}`,
        {
          modal: true,
          detail:
            'Enter this code in the Gezel desktop app to let Visual Studio Code use your ' +
            'Gezel workspace and models. Do not approve if you did not start this connection.',
        },
        'Copy Code',
      );
      if (action === 'Copy Code') {
        await vscode.env.clipboard.writeText(code);
        void vscode.window.showInformationMessage(
          'Gezel connection code copied. Enter it in the Gezel desktop app.',
        );
      }
    });
  } finally {
    stillWaiting.value = false;
    clearTimeout(waitToastTimer);
  }
}

/**
 * Build a human-readable snapshot of the extension's pipeline so the
 * user (or whoever's debugging an empty-panel / missing-models problem)
 * can see every stage's outcome in one shot.
 */
function buildStatusReport(state: ExtensionState): string {
  const lines: string[] = [];
  lines.push('Gezel status');
  lines.push('—'.repeat(40));
  if (state.connection) {
    lines.push(`Daemon       : ${state.connection.mode} @ ${state.connection.baseUrl}`);
    lines.push(`Daemon PID   : ${state.connection.pid ?? '(unknown)'}`);
    lines.push(`Cert         : ${state.connection.cert ? 'loopback TLS pinned' : 'plain HTTP'}`);
  } else {
    lines.push('Daemon       : NOT connected');
  }
  lines.push(`Active gezel : ${state.activeGezel?.name ?? '(none)'}`);
  lines.push(`Active proj  : ${state.activeProjectId ?? '(none)'}`);
  lines.push(`Active folder: ${state.activeFolder?.uri.fsPath ?? '(none)'}`);
  lines.push(
    `LM provider  : ${state.lmProviderDisposable ? 'registered (vendor=gezel)' : 'NOT registered'}`,
  );
  if (state.lastError) {
    lines.push('');
    lines.push(`Last error (${state.lastError.stage}):`);
    lines.push(`  ${state.lastError.message}`);
  }
  return lines.join('\n');
}

async function rewireProject(
  state: ExtensionState,
  client: GezelClient,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const folder = state.activeFolder;
  if (!folder) {
    state.activeProjectId = null;
    return;
  }
  const cacheKey = folder.uri.toString();
  const cached = state.projectCache.get(cacheKey);
  if (cached) {
    state.activeProjectId = cached;
    return;
  }
  const projectId = await ensureProjectForWorkspace(folder, client, logger);
  state.projectCache.set(cacheKey, projectId);
  state.activeProjectId = projectId;
}
