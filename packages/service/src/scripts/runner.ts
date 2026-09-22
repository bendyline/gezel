import { type ScriptRun, createLogger } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import {
  PortableScriptRunner,
  type RunPortableScriptOptions,
  type ScriptExecutor,
} from '@bendyline/gezel-script-runtime';
import type { ChatManager } from '../chat/manager.js';
import type { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { type CredentialRegistry, DefaultCredentialRegistry } from '../secrets/registry.js';
import type { SecretStore } from '../secrets/types.js';
import type { TaskManager } from '../tasks/manager.js';
import { type DispatcherDeps, buildDispatcher } from './dispatcher.js';
import { NodeScriptExecutor } from './node-executor.js';
import { NodeScriptHost, extractScriptFailureFromStderr } from './node-host.js';

export { extractScriptFailureFromStderr };

const log = createLogger('scripts');

export interface ScriptRunnerOptions {
  /** Host-selected execution engine. Scripts cannot select or replace it. */
  executor?: ScriptExecutor;
  store: Store;
  /** Backs `llm.oneShot`; a runner without one refuses that call. */
  chat?: Pick<ChatManager, 'oneShotCompletion'>;
  /** Backs the `gezel.memory.*` script API. Injected by service.ts. */
  memory?: MemoryManager;
  /** Backs the mutating `gezel.task.*` script API. Injected by service.ts. */
  tasks?: TaskManager;
  /** Max depth for `gezel.script.run` recursion. Default: 4. */
  maxNestedDepth?: number;
  /** Default timeout for a single run. Default: 5 min. Max: 30 min. */
  defaultTimeoutMs?: number;
  /** Custom MCP call forwarder. Injected by service.ts when the bridge is ready. */
  mcpCall?: DispatcherDeps['mcpCall'];
  /** Resolves `credential:<name>` capabilities for `http.authed`. */
  credentials?: CredentialRegistry;
  /** Builds the default credential registry when `credentials` is not given. */
  secrets?: SecretStore;
  /** Catalog for provenance trust of installed project-type and test-shim scripts. */
  catalog?: CatalogService;
}

/** The desktop accepts every option the shared runner does, `inlineSource` included. */
export type RunScriptOptions = RunPortableScriptOptions;

export interface ScriptRunResult {
  run: ScriptRun;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const MAX_CASCADE_DEPTH = 4;

/**
 * The desktop script runner: the shared `PortableScriptRunner` over a Node
 * host. Admission, capability narrowing, live policy rechecks, per-call
 * audit persistence, nesting, timeouts, redaction and effect draining are
 * the shared runner's; this class owns what the desktop adds, which is the
 * dispatcher with its desktop-only methods and its late-bound services.
 */
export class ScriptRunner {
  private readonly store: Store;
  private readonly chat: Pick<ChatManager, 'oneShotCompletion'> | undefined;
  private readonly memory?: MemoryManager;
  private readonly tasks?: TaskManager;
  private readonly credentials?: CredentialRegistry;
  private mcpCall: DispatcherDeps['mcpCall'];
  private indexAccess: DispatcherDeps['index'];
  private readonly host: NodeScriptHost;
  private readonly portable: PortableScriptRunner;

  constructor(opts: ScriptRunnerOptions) {
    this.store = opts.store;
    this.chat = opts.chat;
    this.memory = opts.memory;
    this.tasks = opts.tasks;
    this.mcpCall = opts.mcpCall;
    this.credentials =
      opts.credentials ??
      (opts.secrets
        ? new DefaultCredentialRegistry(this.store, opts.secrets, this.store.historyManager)
        : undefined);
    this.host = new NodeScriptHost({
      store: this.store,
      catalog: opts.catalog,
      dispatcher: this.buildDispatcherWithDeps(),
    });
    const host = this.host;
    this.portable = new PortableScriptRunner({
      executor: opts.executor ?? new NodeScriptExecutor(),
      resolve: (name, scope, context) => host.resolve(name, scope, context),
      readConfig: () => host.readConfig(),
      workspaceWriteAllowed: (projectId) => host.workspaceWriteAllowed(projectId),
      dispatch: (context, method, params) => host.dispatch(context, method, params),
      persistRun: (run) => host.persistRun(run),
      describeFailure: (result) => host.describeFailure(result),
      limits: {
        maxNestedDepth: opts.maxNestedDepth ?? MAX_CASCADE_DEPTH,
        defaultTimeoutMs: Math.min(opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
        maxTimeoutMs: MAX_TIMEOUT_MS,
      },
    });
  }

  private buildDispatcherWithDeps(): ReturnType<typeof buildDispatcher> {
    return buildDispatcher({
      store: this.store,
      ...(typeof this.chat?.oneShotCompletion === 'function'
        ? { oneShot: (...args) => this.chat!.oneShotCompletion(...args) }
        : {}),
      memory: this.memory,
      tasks: this.tasks,
      mcpCall: this.mcpCall,
      credentials: this.credentials,
      index: this.indexAccess,
    });
  }

  /** Wire the MCP bridge forwarder once the bridge exists, after boot ordering. */
  setMcpCall(fn: DispatcherDeps['mcpCall']): void {
    this.mcpCall = fn;
    this.host.setDispatcher(this.buildDispatcherWithDeps());
  }

  /** Wire the `index.*` methods once the index managers exist. */
  setIndexAccess(access: DispatcherDeps['index']): void {
    this.indexAccess = access;
    this.host.setDispatcher(this.buildDispatcherWithDeps());
  }

  async run(opts: RunScriptOptions): Promise<ScriptRun> {
    log.debug?.(`[scripts] run ${opts.scope ?? 'project'}/${opts.scriptName} in ${opts.projectId}`);
    return this.portable.run(opts);
  }
}
