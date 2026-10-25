import { AsyncLocalStorage } from 'node:async_hooks';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  HARNESS_CONNECT_ERRORS,
  type HarnessClientId,
  type HarnessConnectRequest,
  type HarnessConnectResponse,
  HarnessConnectResponseSchema,
} from '@bendyline/gezel';
import {
  DaemonNotRunningError,
  type GezelClient,
  LiveDaemonUnhealthyError,
  type LocalGezel,
  type LocalGezelLaunch,
  type LocalGezelOptions,
  connectToLocalGezel,
  judgeDaemonHealth,
} from '@bendyline/gezel-client/node';

/**
 * One outside AI app's connection to Gezel: which folder it works in, the
 * project-bound `harness` token traded for it, and the daemon it follows
 * across restarts. Every Gezel request a tool makes carries the token of the
 * binding that tool call is running under (an AsyncLocalStorage, because a
 * VS Code window with several folders holds one token per project), and the
 * owner credential never rides one.
 */

export const GEZEL_NOT_RUNNING =
  "Gezel isn't running. Open the Gezel app (or run `gezel start`), then try again.";
const GEZEL_TOO_OLD =
  "This version of Gezel can't share its tools with other apps yet. Update Gezel, then try again.";

/** A refusal or outage the app's model should read and pass on, verbatim. */
export class HarnessUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessUnavailableError';
  }
}

export interface HarnessOptions {
  client: HarnessClientId;
  /** Bind this project, whatever folder the app is in (Claude Desktop, VS Code's extension). */
  projectId?: string;
  /** Bind this folder instead of the MCP roots or the working directory. */
  folder?: string;
  /** A Gezel home other than `$GEZEL_HOME` or `~/.gezel`. */
  home?: string;
  /** The process's working directory. A test seam. */
  cwd?: string;
  /** Replaces `connectToLocalGezel`. A test seam. */
  connect?: (opts: LocalGezelOptions) => Promise<LocalGezel>;
}

export interface HarnessBinding {
  key: string;
  request: HarnessConnectRequest;
  /** The folder the app is working in, when it named one. */
  folder?: string;
  launchKey?: string;
  token?: string;
  info?: HarnessConnectResponse;
}

/** The bound project's id, or null for an app bound to no project. */
export function boundProjectId(binding: HarnessBinding): string | null {
  return binding.info?.project?.id ?? null;
}

function isSameOrInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export class HarnessSession {
  readonly client: HarnessClientId;
  private readonly opts: HarnessOptions;
  private local: LocalGezel | null = null;
  private connecting: Promise<LocalGezel> | null = null;
  private readonly bindings = new Map<string, HarnessBinding>();
  private roots: string[] | null | undefined;
  private rootsProvider: (() => Promise<string[] | null>) | null = null;
  private readonly current = new AsyncLocalStorage<HarnessBinding>();
  private readonly closers: Array<() => Promise<void>> = [];

  constructor(opts: HarnessOptions) {
    this.opts = opts;
    this.client = opts.client;
  }

  /** How the session asks the MCP client for its workspace folders. */
  setRootsProvider(provider: () => Promise<string[] | null>): void {
    this.rootsProvider = provider;
  }

  /** The client said its folders changed. */
  invalidateRoots(): void {
    this.roots = undefined;
  }

  /** The Gezel client, connected to the running service. */
  async api(): Promise<GezelClient> {
    return (await this.connection()).client;
  }

  /**
   * The binding for a tool call. `pathHint` (an absolute path the call names)
   * picks among several workspace folders.
   */
  async bind(pathHint?: string): Promise<HarnessBinding> {
    const target = await this.target(pathHint);
    let binding = this.bindings.get(target.key);
    if (!binding) {
      binding = target;
      this.bindings.set(target.key, binding);
    }
    const local = await this.connection();
    const launch = local.launch();
    if (binding.launchKey !== launch.key || !binding.token) await this.exchange(launch, binding);
    return binding;
  }

  /** Run `fn` with every Gezel request carrying `binding`'s token. */
  run<T>(binding: HarnessBinding, fn: (api: GezelClient) => Promise<T>): Promise<T> {
    return this.current.run(binding, async () => fn(await this.api()));
  }

  /** Run `fn` when the app disconnects: processes a tool started for it. */
  onClose(fn: () => Promise<void>): void {
    this.closers.push(fn);
  }

  async close(): Promise<void> {
    await Promise.all(this.closers.map((fn) => fn().catch(() => {})));
    await this.local?.close().catch(() => {});
    this.local = null;
  }

  private async target(pathHint?: string): Promise<HarnessBinding> {
    const { client } = this.opts;
    if (this.opts.projectId) {
      return {
        key: `project:${this.opts.projectId}`,
        request: { client, projectId: this.opts.projectId },
      };
    }
    // Claude Desktop has no working folder; its launch directory is its own install.
    if (client === 'claude-desktop' && !this.opts.folder) {
      return { key: 'none', request: { client } };
    }
    const folders = this.opts.folder ? [resolve(this.opts.folder)] : await this.workspaceFolders();
    const hint = pathHint && isAbsolute(pathHint) ? pathHint : undefined;
    const inside = hint
      ? folders.filter((f) => isSameOrInside(hint, f)).sort((a, b) => b.length - a.length)[0]
      : undefined;
    const folder = inside ?? folders[0];
    if (!folder) return { key: 'none', request: { client } };
    return { key: `folder:${folder}`, request: { client, folder }, folder };
  }

  private async workspaceFolders(): Promise<string[]> {
    if (this.roots === undefined) {
      this.roots = this.rootsProvider ? await this.rootsProvider().catch(() => null) : null;
    }
    if (this.roots && this.roots.length > 0) return this.roots;
    return [resolve(this.opts.cwd ?? process.cwd())];
  }

  private connection(): Promise<LocalGezel> {
    if (this.local) return Promise.resolve(this.local);
    this.connecting ??= this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async open(): Promise<LocalGezel> {
    const connect = this.opts.connect ?? connectToLocalGezel;
    let local: LocalGezel;
    try {
      local = await connect({
        ...(this.opts.home ? { home: this.opts.home } : {}),
        credential: {
          token: (launch) => this.tokenFor(launch),
          rejected: async () => {
            const binding = this.current.getStore();
            if (!binding) return false;
            binding.token = undefined;
            return true;
          },
        },
      });
    } catch (err) {
      if (err instanceof DaemonNotRunningError || err instanceof LiveDaemonUnhealthyError) {
        throw new HarnessUnavailableError(GEZEL_NOT_RUNNING);
      }
      throw err;
    }
    const health = await local.client.health().catch(() => null);
    const verdict = health ? judgeDaemonHealth(health, { client: 'gezel-mcp' }) : null;
    if (verdict && !verdict.compatible) {
      await local.close().catch(() => {});
      throw new HarnessUnavailableError(`${verdict.reason} ${GEZEL_TOO_OLD}`);
    }
    this.local = local;
    return local;
  }

  private async tokenFor(launch: LocalGezelLaunch): Promise<string | null> {
    // Outside a tool call (the connection's own health check) nothing is sent:
    // only the unauthenticated health route answers that.
    const binding = this.current.getStore();
    if (!binding) return null;
    if (binding.launchKey !== launch.key || !binding.token) await this.exchange(launch, binding);
    if (!binding.token) throw new HarnessUnavailableError(GEZEL_NOT_RUNNING);
    return binding.token;
  }

  private async exchange(launch: LocalGezelLaunch, binding: HarnessBinding): Promise<void> {
    let res: Response;
    try {
      res = await launch.ownerFetch('/v1/apps/harness-connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(binding.request),
      });
    } catch {
      throw new HarnessUnavailableError(GEZEL_NOT_RUNNING);
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status === 404) throw new HarnessUnavailableError(GEZEL_TOO_OLD);
    if (!res.ok) {
      const hint = typeof body?.hint === 'string' ? body.hint : null;
      const code = typeof body?.error === 'string' ? body.error : '';
      if ((HARNESS_CONNECT_ERRORS as readonly string[]).includes(code) && hint) {
        throw new HarnessUnavailableError(hint);
      }
      throw new HarnessUnavailableError(
        hint ?? `Gezel could not connect this app (HTTP ${res.status}).`,
      );
    }
    const info = HarnessConnectResponseSchema.parse(body);
    binding.info = info;
    binding.token = info.token;
    binding.launchKey = launch.key;
  }
}
