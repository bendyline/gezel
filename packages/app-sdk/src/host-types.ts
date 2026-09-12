import type { GezelClient } from '@bendyline/gezel-client/node';
import type { LocalConnectInput, LocalDaemonMode } from './types.js';

/**
 * Types for hosting a Gezel daemon inside your own application.
 *
 * As in `types.ts`, nothing here imports `@bendyline/gezel`: the service is an
 * optional peer, and an app that only connects to a running Gezel must be able
 * to install this SDK without it.
 */

/** Minimal shape of `@bendyline/gezel-service` this SDK depends on. */
export interface HostServiceModule {
  startService(opts: Record<string, unknown>): Promise<{
    port: number;
    clientToken: string;
    cert: { certPem: string } | null;
    stop: () => Promise<void>;
  }>;
}

export interface HostLogger {
  info?(message: string): void;
  warn?(message: string): void;
}

export interface HostOptions {
  /**
   * Where this app's Gezel state lives. Defaults to
   * `<GEZEL_HOME ?? ~/.gezel>/apps/<appId>`.
   *
   * An app gets its own home rather than sharing the user's. Two reasons: the
   * user's daemon is a single-writer process that Gezel's desktop shell owns
   * and may restart, and an app's projects and gezels are the app's own
   * furniture — they would otherwise appear in the user's workshop as
   * something they never made and cannot safely edit.
   */
  home?: string;
  /**
   * Absolute path to a `node` binary for the daemon's child processes (the
   * MCP tool server, sandboxed scripts). Required under Electron, where
   * `process.execPath` is the app binary rather than Node.
   */
  nodePath?: string;
  /** A verified native-engine directory this app ships, if it ships one. */
  nativeBinDir?: string;
  /**
   * Other Gezel homes whose installed models this daemon may read. Defaults
   * to the user's own `~/.gezel`, so a model the user already downloaded is
   * not downloaded a second time. Read-only in both directions: the app never
   * writes there, and the user's Gezel never sees the app's projects.
   */
  readOnlyModelHomes?: string[];
  /**
   * Run the daemon's system bootstrap (Playwright plus a ~280 MB Chromium)
   * and its first-run model pin. Off by default — an app that ships a chat
   * bot should not make the user pay for a browser it will never open.
   */
  systemBootstrap?: boolean;
  /** Pre-loaded service module, for apps that bundle it under another name. */
  serviceModule?: HostServiceModule;
  /** Import specifier or file URL for the service module. */
  serviceEntry?: string;
  onUnexpectedHttpError?: (event: unknown) => void;
  logger?: HostLogger;
}

/**
 * How the connection was obtained. The first four come from
 * {@link LocalDaemonMode}; hosting adds two of its own.
 */
export type ConnectionMode = LocalDaemonMode | 'hosted' | 'hosted-adopted';

export interface ConnectOrHostInput extends Omit<LocalConnectInput, 'scopes'> {
  /** Defaults to `['product', 'openai']` — projects, chats, and inference. */
  scopes?: string[];
  /**
   * Host a daemon in this process when none is running. Opt-in, like
   * `daemon.spawnIfMissing`: hosting writes to disk and owns a process, so an
   * app asks for it explicitly.
   */
  host?: HostOptions;
  /**
   * Try the user's own running Gezel first (with the consent handshake).
   * Default true. Set false for an app that should always stay in its own
   * home, whatever else is installed.
   */
  adoptUserDaemon?: boolean;
}

/**
 * The resolved daemon behind a {@link import('./gezel.js').Gezel}: where it
 * is, how to reach it, and how it was obtained.
 */
export interface DaemonConnection {
  mode: ConnectionMode;
  baseUrl: string;
  token: string;
  fetch: typeof fetch;
  client: GezelClient;
  /** Set for hosted modes: the gezel home this daemon owns. */
  home?: string;
  pid?: number;
  cert: string | null;
  /** Stops a daemon this process started; otherwise releases the transport. */
  close(): Promise<void>;
}

export type EnsureModelEngine = 'llama-cpp' | 'mlx';

export interface EnsureModelOptions {
  /** Catalog id, e.g. `gemma4-e2b-q4`. */
  model: string;
  /** Defaults to the engine this platform runs best. */
  engine?: EnsureModelEngine | 'auto';
  /**
   * A `.gezmodel` bundle this app ships, used when the model is not already
   * installed. Lets a first run work with no network at all.
   */
  bundle?: string;
  /** Make this the daemon's default model. Defaults to true when hosting. */
  pinAsDefault?: boolean;
  onEvent?(event: EnsureProgressEvent): void;
  signal?: AbortSignal;
}

export type EnsureProgressEvent =
  | { phase: 'engine'; engine: string; message: string; percent?: number }
  | { phase: 'weights'; message: string; bytesWritten?: number; totalBytes?: number }
  | { phase: 'bundle'; message: string; bytesCompleted?: number; bytesTotal?: number }
  | { phase: 'ready'; model: string; engine: EnsureModelEngine; source: EnsureModelSource };

export type EnsureModelSource = 'present' | 'bundle' | 'download';

export interface EnsureModelResult {
  model: string;
  engine: EnsureModelEngine;
  source: EnsureModelSource;
  pinned: boolean;
}

export interface EnsureProjectOptions {
  /**
   * The `.gezapp` this application ships, as bytes or a path. Omit it to bind
   * the folder to a project without applying an AI App.
   */
  package?: Uint8Array | string;
  /** Folder that becomes the project's working directory. */
  folder: string;
  params?: Record<string, unknown>;
  version?: string;
  /** Ensure the app's declared chat-model dependencies. Defaults to true. */
  ensureModels?: boolean;
  /** `.gezmodel` bundles by catalog id, for offline model dependencies. */
  bundles?: Record<string, string>;
  /** Adopt a folder that another app's project already claims. */
  force?: boolean;
  onEvent?(event: EnsureProgressEvent): void;
}

/** What ensuring the project produced. Surfaced through the project handle. */
export interface EnsureProjectResult {
  /** Absent when no `.gezapp` was applied. */
  appId?: string;
  version?: string;
  projectId: string;
  /** Gezel id by role template id, e.g. `{ 'travel-guide': 'mira' }`. */
  gezels: Record<string, string>;
  /** The gezel the app's project type marks as its lead, when it names one. */
  leadGezelId?: string;
  /** False when this exact package was already installed; absent with no app. */
  imported?: boolean;
  modelsEnsured: string[];
}

export interface OpenChatOptions {
  projectId: string;
  gezelId?: string;
  /** Role template id or role name, when the app did not keep the gezel id. */
  role?: string;
  /** Continue the most recent thread instead of starting one. Default true. */
  reuseLatestSession?: boolean;
}

/**
 * The events an app needs from a turn. Deliberately a narrow union over the
 * daemon's much larger event vocabulary: anything else arrives as `other` with
 * the raw payload, so a new daemon event is never a breaking change here.
 */
export type ChatTurnEvent =
  | { type: 'delta'; content: string }
  | { type: 'reasoning_delta'; content: string }
  | { type: 'tool'; name: string; success: boolean; errorMessage?: string }
  | { type: 'tool_args_delta'; name: string; content: string }
  | { type: 'complete'; content: string }
  | { type: 'question_asked'; question: unknown }
  | { type: 'question_answered'; question: unknown }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string }
  | { type: 'done' }
  | { type: 'other'; event: unknown };
