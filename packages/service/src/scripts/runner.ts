import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type ScriptCapability,
  type ScriptMeta,
  type ScriptRun,
  type ScriptRunCall,
  type ScriptRunStatus,
  type ScriptRunTrigger,
  type ScriptScope,
  createLogger,
  getEngagementMode,
  isEngagementAllowed,
  resolveSecurityPolicy,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import {
  projectScriptFile,
  projectScriptRunFile,
  projectScriptRunsDir,
  userScriptFile,
} from '@bendyline/gezel/paths';
import type { ChatManager } from '../chat/manager.js';
import type { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { redactObject, redactString } from '../providers/mcp-bridge.js';
import { type SandboxRunResult, runInSandbox } from '../sandbox/runner.js';
import { type CredentialRegistry, DefaultCredentialRegistry } from '../secrets/registry.js';
import type { SecretStore } from '../secrets/types.js';
import type { TaskManager } from '../tasks/manager.js';
import {
  CapabilityDeniedError,
  type DispatcherContext,
  type DispatcherDeps,
  EngagementDeniedError,
  buildDispatcher,
} from './dispatcher.js';
import { validateScriptInput } from './input-validator.js';
import { parseScriptMeta } from './meta.js';
import { SDK_PACKAGE_NAME, resolveSdkDir } from './sdk.js';
import { stdlibScriptFile } from './stdlib-source.js';

const log = createLogger('scripts');

export interface ScriptRunnerOptions {
  store: Store;
  chat: ChatManager;
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
  /**
   * Optional. When provided, scripts can resolve named credentials via
   * `credential:<name>` capabilities. If omitted, the runner still
   * operates; scripts that declare credential capabilities simply
   * can't resolve them (any attempt via the `http.authed` dispatcher
   * entry will error).
   */
  credentials?: CredentialRegistry;
  /**
   * When `credentials` is omitted and a `secrets` store is provided,
   * construct a `DefaultCredentialRegistry` from `(store, secrets)`.
   * Service.ts uses this path at boot.
   */
  secrets?: SecretStore;
  /**
   * Optional. Backs provenance verification for the trusted-lane sandbox
   * fallback: a project script whose bytes exactly match the catalog-
   * shipped project-type script may run on platforms with no OS network
   * boundary (Windows; Linux with the RPC channel). Without a catalog,
   * no project script is ever provenance-trusted and such platforms keep
   * failing closed.
   */
  catalog?: CatalogService;
}

export interface RunScriptOptions {
  projectId: string;
  scriptName: string;
  /**
   * Where the script resolves from. Explicit scope only — no fallback
   * chain. Absent = `'project'`. `'craftbook'` refs resolve from the
   * craftbook's embedded scripts map when the caller passes
   * `inlineSource`, else from the project-installed copy (install.ts).
   */
  scope?: ScriptScope;
  /**
   * The script's TypeScript source, supplied directly instead of resolved
   * from disk — how a craftbook's embedded `scripts` map executes. Never
   * valid with `scope: 'standard'` (inline sources are project/local
   * trust; the trusted stdlib only ever loads from the app's own tree).
   */
  inlineSource?: string;
  inputs?: Record<string, unknown>;
  trigger: ScriptRunTrigger;
  depth?: number;
  timeoutMs?: number;
}

export interface ScriptRunResult {
  run: ScriptRun;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const MAX_CASCADE_DEPTH = 4;

/**
 * Owns the script execution pipeline: meta read → input validation →
 * scratch setup → sandbox spawn with fd-3 RPC → dispatcher → run
 * persistence. One instance per service; callers drive it through
 * `run()` (for chat/manual triggers) or the phase-hook wiring in
 * TaskManager.
 */
export class ScriptRunner {
  private readonly store: Store;
  private readonly chat: ChatManager;
  private readonly memory?: MemoryManager;
  private readonly tasks?: TaskManager;
  private readonly maxNestedDepth: number;
  private readonly defaultTimeoutMs: number;
  private readonly credentials?: CredentialRegistry;
  private readonly catalog?: CatalogService;
  private dispatcher: ReturnType<typeof buildDispatcher>;
  private mcpCall: DispatcherDeps['mcpCall'];

  constructor(opts: ScriptRunnerOptions) {
    this.store = opts.store;
    this.chat = opts.chat;
    this.memory = opts.memory;
    this.tasks = opts.tasks;
    this.maxNestedDepth = opts.maxNestedDepth ?? MAX_CASCADE_DEPTH;
    this.defaultTimeoutMs = Math.min(opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    this.catalog = opts.catalog;
    this.mcpCall = opts.mcpCall;
    this.credentials =
      opts.credentials ??
      (opts.secrets
        ? new DefaultCredentialRegistry(this.store, opts.secrets, this.store.historyManager)
        : undefined);

    this.dispatcher = buildDispatcher({
      store: this.store,
      chat: this.chat,
      memory: this.memory,
      tasks: this.tasks,
      mcpCall: this.mcpCall,
      credentials: this.credentials,
      runNested: (parentCtx, name, input) => this.runNested(parentCtx, name, input),
    });
  }

  /**
   * Allow `service.ts` to wire in the MCP bridge forwarder after both
   * the bridge and the runner have been constructed. This avoids a
   * circular dep during service boot.
   */
  setMcpCall(fn: DispatcherDeps['mcpCall']): void {
    this.mcpCall = fn;
    this.dispatcher = buildDispatcher({
      store: this.store,
      chat: this.chat,
      memory: this.memory,
      tasks: this.tasks,
      mcpCall: fn,
      credentials: this.credentials,
      runNested: (parentCtx, name, input) => this.runNested(parentCtx, name, input),
    });
  }

  async run(opts: RunScriptOptions): Promise<ScriptRun> {
    const depth = opts.depth ?? 0;
    if (depth > this.maxNestedDepth) {
      throw new Error(`nested script depth exceeded (max ${this.maxNestedDepth})`);
    }

    const scope = opts.scope ?? 'project';
    if (opts.inlineSource !== undefined && scope === 'standard') {
      throw new Error(
        'inline script sources cannot run at standard scope — the trusted stdlib only loads from the app tree',
      );
    }
    const source =
      opts.inlineSource ??
      (await readFile(
        await this.resolveScriptPath(opts.projectId, opts.scriptName, scope),
        'utf8',
      ));
    const meta = parseScriptMeta(
      source,
      opts.inlineSource !== undefined
        ? `<craftbook>/${opts.scriptName}.ts`
        : `${scope}/${opts.scriptName}.ts`,
    );

    // Step-trigger convenience: a script that DECLARES `taskRef`/`stepId`
    // inputs gets them filled from the triggering step when the caller
    // didn't supply values — that's how e.g. checkTaskNoteContains knows
    // which task it is gating without per-task craftbook edits. Only
    // declared inputs are filled (validateScriptInput rejects unknowns).
    let rawInputs = opts.inputs;
    if (opts.trigger.kind === 'step') {
      const auto: Record<string, unknown> = {};
      if (meta.inputs?.taskRef && rawInputs?.taskRef === undefined) {
        auto.taskRef = opts.trigger.taskRef;
      }
      if (meta.inputs?.stepId && rawInputs?.stepId === undefined) {
        auto.stepId = opts.trigger.stepId;
      }
      if (Object.keys(auto).length > 0) rawInputs = { ...auto, ...(rawInputs ?? {}) };
    }

    // Validate input against meta, applying defaults and required checks.
    const validatedInput = validateScriptInput(meta, rawInputs);

    // Resolve engagement mode once at the start of the run.
    const config = await this.store.readConfig();
    const llmAllowed = isEngagementAllowed(config);
    const engagementMode = getEngagementMode(config);

    // Centralized security ceiling on model/automation-initiated script
    // execution. `chat` (a gezel ran a script mid-turn) and `step` (a
    // craftbook step) are the agentic paths gated by `allowScriptExecution`.
    // `manual` is user-initiated and `nested` inherits its already-
    // authorized parent — both stay exempt (the agency axis). The app's own
    // npm/node/CLI/MCP execution is a different code path and is unaffected.
    // STANDARD-scope scripts are exempt too: they are packed into the app,
    // read-only, and resolution only ever reads from the app's own stdlib
    // directory — running them is running the product, not user code.
    const securityPolicy = resolveSecurityPolicy(config);
    if (
      !securityPolicy.allowScriptExecution &&
      scope !== 'standard' &&
      (opts.trigger.kind === 'chat' || opts.trigger.kind === 'step')
    ) {
      throw new Error(
        'Security policy: script execution is disabled. Raise the security level in Settings → Security & Compliance to let gezels run scripts.',
      );
    }

    const runId = randomUUID();
    const startedAt = new Date().toISOString();

    const run: ScriptRun = {
      id: runId,
      projectId: opts.projectId,
      scriptName: opts.scriptName,
      startedAt,
      status: 'running',
      trigger: opts.trigger,
      inputs: validatedInput,
      calls: [],
      logs: '',
    };

    const allowedCapabilities = new Set<ScriptCapability>(meta.requires ?? []);
    // Declared-but-gated capabilities, with the reason — flows into
    // CapabilityDeniedError so the failure names the actual gate instead
    // of the misleading "did not declare it in meta.requires".
    const strippedCapabilities = new Map<ScriptCapability, string>();
    const stripCapability = (cap: ScriptCapability, reason: string) => {
      if (allowedCapabilities.delete(cap)) strippedCapabilities.set(cap, reason);
    };
    // Security ceiling: when external services are off, deny a script the
    // `network` and `credential:*` capabilities even if its meta requests
    // them. The dispatcher then raises CapabilityDeniedError on any
    // mcp.call / http.authed the script attempts — no silent egress.
    if (!securityPolicy.allowExternalServices) {
      const reason =
        'external services are disabled by the security policy (Settings → Security & Compliance)';
      stripCapability('network', reason);
      for (const cap of [...allowedCapabilities]) {
        if (cap.startsWith('credential:')) stripCapability(cap, reason);
      }
    }
    // Per-project write gate: `workspace.write` follows the same
    // contract as every other workspace-write surface (internal
    // workspaces writable, external dirs opt-in, explicit per-project
    // "edits off" respected) — scripts count as gezel-initiated work.
    // The global policy deliberately does not factor in, so a fresh
    // internal project (a checkers board) keeps working under
    // super-lockdown. `documents.write` targets the shared cross-project
    // library, so it stays on the global file-edits posture. Artifacts
    // stay writable — the locked-down "write to the sandbox, not the
    // source" escape hatch.
    if (allowedCapabilities.has('workspace.write')) {
      const writeGate = await this.store.assertWorkspaceWritable(opts.projectId, {
        initiatedByGezel: true,
      });
      if (!writeGate.ok) {
        stripCapability(
          'workspace.write',
          writeGate.reason === 'missing-flag-external'
            ? 'gezel writes to this project\'s external working directory require "Allow gezels to modify the workspace directory" in Project → Settings'
            : 'gezel workspace writes are turned off for this project (Project → Settings)',
        );
      }
    }
    if (!securityPolicy.allowFileEdits) {
      stripCapability(
        'documents.write',
        'file edits are disabled by the security policy (Settings → Security & Compliance)',
      );
    }
    const knownSecretValues = new Set<string>();
    const ctx: DispatcherContext = {
      projectId: opts.projectId,
      runId,
      scriptName: opts.scriptName,
      engagementFlags: { llmAllowed },
      allowedCapabilities,
      ...(strippedCapabilities.size > 0 ? { strippedCapabilities } : {}),
      knownSecretValues,
    };

    const timeoutMs = Math.min(opts.timeoutMs ?? this.defaultTimeoutMs, MAX_TIMEOUT_MS);
    let outputStamped: unknown;
    let outputSeen = false;

    const provenanceTrusted = await this.isProvenanceTrusted(
      scope,
      source,
      opts.scriptName,
      opts.inlineSource !== undefined,
    );
    const trustedReadOnlyStandard =
      scope === 'standard' &&
      provenanceTrusted &&
      [...allowedCapabilities].every((capability) => capability.endsWith('.read'));

    const scratch = await this.prepareScratch(source, opts.scriptName);
    try {
      const result = await this.runSandbox({
        scratch,
        scriptName: opts.scriptName,
        provenanceTrusted,
        trustedReadOnlyStandard,
        init: {
          input: validatedInput,
          runId,
          projectId: opts.projectId,
          engagementMode,
          engagementFlags: { llmAllowed },
        },
        timeoutMs,
        onRequest: async (method, params) => this.dispatcher.dispatch(ctx, method, params),
        onNotification: (method, params) => {
          if (method === 'script.output') {
            if (outputSeen) {
              return; // already recorded; silently drop
            }
            outputSeen = true;
            outputStamped = (params as { value?: unknown } | undefined)?.value;
          } else if (method === 'script.log') {
            const args = (params as { args?: unknown[] } | undefined)?.args ?? [];
            run.logs += `${args.map(summarize).join(' ')}\n`;
          }
        },
        recordCall: (call) => {
          run.calls.push(call);
        },
        onStdout: (line) => {
          run.logs += `[stdout] ${line}\n`;
        },
        onStderr: (line) => {
          run.logs += `[stderr] ${line}\n`;
        },
      });

      if (result.sandboxFallback) {
        run.logs +=
          '[sandbox] macOS Seatbelt failed to start; retried byte-verified read-only standard script under the Node permission and network-neutralizer layers.\n';
      }
      run.finishedAt = new Date().toISOString();
      if (result.timedOut) {
        run.status = 'error';
        run.error = `script timed out after ${timeoutMs}ms`;
      } else if (result.exitCode !== 0) {
        run.status = 'error';
        // Keep the script's thrown Error line. Script-backed tools use this
        // field as their repair signal, so collapsing an illegal-move error
        // (including its authoritative legal-move list) to "exited with
        // code 1" leaves the model guessing from stale transcript state.
        run.error =
          run.error ??
          extractScriptFailureFromStderr(result.stderr) ??
          formatScriptExitFailure(result);
      } else {
        run.status = 'ok';
        if (outputSeen) {
          try {
            run.output = coerceOutput(meta, outputStamped);
          } catch (err) {
            run.status = 'error';
            run.error = err instanceof Error ? err.message : String(err);
          }
        }
      }
    } catch (err) {
      run.finishedAt = new Date().toISOString();
      run.status = 'error';
      run.error = err instanceof Error ? err.message : String(err);
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }

    redactRunInPlace(run, knownSecretValues);
    await this.persistRun(run);
    if (run.status === 'error') {
      log.error(
        `[script-run] runId=${run.id} project=${run.projectId} script=${run.scriptName} ` +
          `trigger=${run.trigger.kind} error=${run.error ?? 'unknown error'} ` +
          `logsTail=${JSON.stringify(tailText(run.logs, 1_500))}`,
      );
    }
    return run;
  }

  async runNested(
    parentCtx: DispatcherContext,
    name: string,
    input?: Record<string, unknown>,
  ): Promise<{ runId: string; status: 'ok' | 'error'; output?: unknown; error?: string }> {
    const nested = await this.run({
      projectId: parentCtx.projectId,
      scriptName: name,
      inputs: input,
      trigger: { kind: 'nested', parentRunId: parentCtx.runId },
      depth: 1,
    });
    return {
      runId: nested.id,
      status: nested.status === 'ok' ? 'ok' : 'error',
      output: nested.output,
      error: nested.error,
    };
  }

  private async prepareScratch(source: string, scriptName: string): Promise<string> {
    // Use the canonical path so Node's permission checks (which compare
    // resolved paths) line up with the --allow-fs-read/write entries we
    // pass. On macOS, /var/folders/… canonicalises to /private/var/...,
    // and Node's ERR_ACCESS_DENIED compares against the canonical form.
    const { realpath } = await import('node:fs/promises');
    const raw = await mkdtemp(join(tmpdir(), 'gezel-script-'));
    const scratch = await realpath(raw);
    await writeFile(join(scratch, 'user-script.ts'), source, 'utf8');
    await writeFile(
      join(scratch, 'package.json'),
      JSON.stringify(
        { name: `gezel-script-${scriptName}`, type: 'module', private: true },
        null,
        2,
      ),
    );
    // Vendor @bendyline/gezel-sdk into scratch/node_modules
    await this.vendorSdk(scratch);
    return scratch;
  }

  /**
   * Resolve a script name + scope to its on-disk source. Explicit scope
   * only — a project script can never shadow a standard one by accident.
   */
  private async resolveScriptPath(
    projectId: string,
    scriptName: string,
    scope: ScriptScope,
  ): Promise<string> {
    switch (scope) {
      case 'standard':
        return stdlibScriptFile(scriptName);
      case 'user':
        return userScriptFile(this.store.homePath, scriptName);
      case 'craftbook':
        // Craftbook-bundled scripts are installed into the project at
        // task creation (scripts/install.ts) — resolve the installed copy.
        return projectScriptFile(this.store.homePath, projectId, scriptName);
      case 'project':
        return projectScriptFile(this.store.homePath, projectId, scriptName);
    }
  }

  /**
   * A script is provenance-trusted when its bytes are provably first-party:
   * the shipped stdlib (standard scope resolves only from the app tree), a
   * project script whose full content equals the provenance header plus
   * the catalog-shipped project-type script body, or a project script
   * matching a catalog-shipped craftbook `test.json` cli-shim body — byte
   * for byte, at the exact version the header names. Trusted scripts may
   * run where `denyNet` has no OS boundary (Windows; Linux with the RPC
   * channel) under the remaining sandbox layers — their IO already flows
   * through the fd-3 dispatcher, never raw sockets. Any edit to the
   * installed file (even whitespace) drops it back to the fail-closed
   * path, as does a version the catalog no longer serves.
   */
  private async isProvenanceTrusted(
    scope: ScriptScope,
    source: string,
    scriptName: string,
    isInline: boolean,
  ): Promise<boolean> {
    if (isInline) return false;
    if (scope === 'standard') return true;
    if (scope !== 'project' || !this.catalog) return false;
    const newline = source.indexOf('\n');
    if (newline < 0) return false;
    const header = source.slice(0, newline);
    const projectType = /^\/\/ @gezel-project-type: ([a-z0-9][a-z0-9-]*)@([0-9A-Za-z.+-]+)$/.exec(
      header,
    );
    if (projectType) {
      const detail = await this.catalog
        .get('project-type', projectType[1]!, undefined, projectType[2]!)
        .catch(() => null);
      if (!detail || detail.manifest.kind !== 'project-type') return false;
      const body = (detail.manifest.scripts as Record<string, string> | undefined)?.[scriptName];
      return typeof body === 'string' && source === `${header}\n${body}`;
    }
    // Eval-harness lane: a craftbook's `test.json` may ship cli-shim
    // scripts (`mocks[].shim`). Those bytes are catalog-shipped exactly
    // like project-type scripts, so an installed copy that byte-matches
    // the shim at the named book@version is first-party too. Used by the
    // eval mock-service rail; a model-edited copy stops matching and
    // falls back to fail-closed.
    const testShim = /^\/\/ @gezel-craftbook-test: ([a-z0-9][a-z0-9-]*)@([0-9A-Za-z.+-]+)$/.exec(
      header,
    );
    if (testShim && typeof this.catalog.getCraftbookTestSpec === 'function') {
      const found = await this.catalog
        .getCraftbookTestSpec(testShim[1]!, testShim[2]!)
        .catch(() => null);
      if (!found) return false;
      for (const mock of found.spec.mocks) {
        if (mock.kind !== 'cli') continue;
        if (source === `${header}\n${mock.shim.content}`) return true;
      }
      return false;
    }
    return false;
  }

  private async vendorSdk(scratch: string): Promise<void> {
    const sdkDir = await resolveSdkDir();
    const target = join(scratch, 'node_modules', SDK_PACKAGE_NAME);
    await mkdir(dirname(target), { recursive: true });
    await cp(sdkDir, target, { recursive: true, filter: (src) => !src.includes('node_modules') });
  }

  private async runSandbox(opts: {
    scratch: string;
    scriptName: string;
    provenanceTrusted: boolean;
    trustedReadOnlyStandard: boolean;
    init: Record<string, unknown>;
    timeoutMs: number;
    onRequest: (method: string, params: unknown) => Promise<unknown>;
    onNotification: (method: string, params: unknown) => void;
    recordCall: (call: ScriptRunCall) => void;
    onStdout: (line: string) => void;
    onStderr: (line: string) => void;
  }): Promise<SandboxRunResult> {
    let sendFrame: ((line: string) => void) | null = null;

    return runInSandbox({
      entry: 'user-script.ts',
      cwd: opts.scratch,
      input: `${JSON.stringify(opts.init)}\n`,
      timeoutMs: opts.timeoutMs,
      stripTypes: true,
      // All script network goes through the dispatcher (parent-side
      // `http.authed` / `llm.oneShot` over the fd-3 RPC channel); the
      // child itself never needs sockets. Deny egress so a script can't
      // bypass the `network` capability gate with a raw `fetch()` and
      // POST workspace data out. (`fetch` IS a reachable Node global —
      // the prior "not reachable through the SDK" assumption was wrong.)
      denyNet: true,
      // Byte-verified first-party scripts may run where no OS network
      // boundary exists (see isProvenanceTrusted); everything else still
      // fails closed there.
      allowMissingNetBoundary: opts.provenanceTrusted,
      allowMacSandboxStartupFallback: opts.trustedReadOnlyStandard,
      // Cap heap so a runaway allocation can't OOM the whole host. The
      // child gets a generous ceiling — enough for normal data-wrangling,
      // far below total system memory.
      maxOldSpaceMb: 1024,
      // Node + the vendored SDK + any userland imports can read from
      // paths outside a tight allowlist (brew prefix, /private/var/…).
      // The real fence that matters is write scoping + no network +
      // per-call capability enforcement at the dispatcher.
      relaxReads: true,
      extraEnv: { GEZEL_SCRIPT_RUNTIME: '1' },
      onStdout: opts.onStdout,
      onStderr: opts.onStderr,
      rpcChannel: {
        onLine: (line) => {
          let msg: { id?: number; method?: string; params?: unknown };
          try {
            msg = JSON.parse(line);
          } catch {
            return;
          }
          if (typeof msg.id === 'number' && typeof msg.method === 'string') {
            const start = Date.now();
            const method = msg.method;
            const params = msg.params;
            opts
              .onRequest(method, params)
              .then((result) => {
                const duration = Date.now() - start;
                opts.recordCall({
                  at: new Date(start).toISOString(),
                  kind: method,
                  argsSummary: summarize(params).slice(0, 256),
                  outputSummary: summarize(result).slice(0, 256),
                  durationMs: duration,
                });
                sendFrame?.(`${JSON.stringify({ id: msg.id, result })}\n`);
              })
              .catch((err: unknown) => {
                const duration = Date.now() - start;
                const message = err instanceof Error ? err.message : String(err);
                const code =
                  err instanceof CapabilityDeniedError
                    ? err.code
                    : err instanceof EngagementDeniedError
                      ? err.code
                      : (err as { code?: string } | null)?.code;
                opts.recordCall({
                  at: new Date(start).toISOString(),
                  kind: method,
                  argsSummary: summarize(params).slice(0, 256),
                  durationMs: duration,
                  error: message,
                });
                sendFrame?.(`${JSON.stringify({ id: msg.id, error: { message, code } })}\n`);
              });
          } else if (typeof msg.method === 'string') {
            opts.onNotification(msg.method, msg.params);
          }
        },
        onOpen: (send) => {
          sendFrame = send;
        },
      },
    });
  }

  private async persistRun(run: ScriptRun): Promise<void> {
    const date = run.startedAt.slice(0, 10);
    const runsDir = projectScriptRunsDir(this.store.homePath, run.projectId);
    const dayDir = join(runsDir, date);
    await mkdir(dayDir, { recursive: true });
    const file = projectScriptRunFile(this.store.homePath, run.projectId, date, run.id);
    await writeFile(file, JSON.stringify(run, null, 2), 'utf8');
  }
}

/**
 * Pull the actionable exception from a child script's stderr without
 * surfacing its stack trace. Sandbox/capability refusals keep priority;
 * ordinary user-script exceptions (Error, TypeError, RangeError, …) are
 * the fallback. The first exception line is the thrown message Node prints.
 */
export function extractScriptFailureFromStderr(stderr: string): string | undefined {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const refusal = lines.find(
    (line) =>
      line.startsWith('[sandbox error]') ||
      line.startsWith('Error: script attempted to call') ||
      line.startsWith('Error: script called'),
  );
  if (refusal) return refusal;
  return lines.find((line) => /^(?:Error|[A-Za-z][A-Za-z0-9]*Error):\s+\S/.test(line));
}

function formatScriptExitFailure(result: SandboxRunResult): string {
  const exit = result.signal
    ? `script closed by signal ${result.signal}`
    : `script exited with code ${result.exitCode}`;
  const stderrTail = tailText(result.stderr, 600);
  return stderrTail.length > 0 ? `${exit}: ${stderrTail}` : `${exit} without stderr output`;
}

function tailText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `…${trimmed.slice(trimmed.length - maxChars)}`;
}

function summarize(value: unknown): string {
  if (value === undefined) return '';
  // Collapse JSON's escaped backslashes so Windows paths read with single
  // separators (c:\gh\foo, not c:\\gh\\foo) — a 2k-backslash run always
  // encodes k real ones, so halving is lossless. See args-summary.ts.
  if (typeof value === 'string') return JSON.stringify(value).replace(/\\\\/g, '\\');
  try {
    return JSON.stringify(value).replace(/\\\\/g, '\\');
  } catch {
    return String(value);
  }
}

/**
 * Validate the stamped output against `meta.outputs` if declared.
 * Coerces but does not aggressively reshape — we want to catch type
 * mismatches that would mislead downstream consumers, not nit-pick.
 */
function coerceOutput(meta: ScriptMeta, value: unknown): unknown {
  if (!meta.outputs) return value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('script output must be an object when meta.outputs is declared');
  }
  const src = value as Record<string, unknown>;
  for (const [name, spec] of Object.entries(meta.outputs)) {
    const v = src[name];
    if (v === undefined) {
      throw new Error(`output is missing declared field "${name}"`);
    }
    if (v === null) {
      if (spec.type === 'string' || spec.type === 'number' || spec.type === 'boolean') {
        if ((spec as { nullable?: boolean }).nullable) continue;
      }
      if (spec.type === 'json') continue;
      throw new Error(`output field "${name}" is null but type ${spec.type} is not nullable`);
    }
    const expected = expectedTypeOf(v);
    switch (spec.type) {
      case 'string':
        if (typeof v !== 'string') throw typeErr(name, 'string', expected);
        break;
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) throw typeErr(name, 'number', expected);
        break;
      case 'boolean':
        if (typeof v !== 'boolean') throw typeErr(name, 'boolean', expected);
        break;
      case 'array':
        if (!Array.isArray(v)) throw typeErr(name, 'array', expected);
        break;
      case 'object':
        if (typeof v !== 'object' || Array.isArray(v)) throw typeErr(name, 'object', expected);
        break;
      case 'json':
        break;
    }
  }
  return src;
}

function expectedTypeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function typeErr(field: string, expected: string, got: string): Error {
  return new Error(`output field "${field}" must be ${expected}, got ${got}`);
}

/**
 * Scrub every known secret value from fields of a `ScriptRun` that a
 * chat-side consumer (the model or a chat-rendered trace) can see.
 * `run.inputs` and `run.trigger` are out of scope — those were
 * supplied by the caller; they never hold credential values (the
 * dispatcher never echoes a secret back as an input value).
 */
function redactRunInPlace(run: ScriptRun, secrets: Set<string>): void {
  if (secrets.size === 0) return;
  run.logs = redactString(run.logs, secrets);
  if (run.error) run.error = redactString(run.error, secrets);
  if (run.output !== undefined) run.output = redactObject(run.output, secrets);
  run.calls = run.calls.map((call) => {
    const out: ScriptRunCall = {
      ...call,
      argsSummary: redactString(call.argsSummary, secrets),
    };
    if (call.outputSummary !== undefined) {
      out.outputSummary = redactString(call.outputSummary, secrets);
    }
    if (call.error !== undefined) {
      out.error = redactString(call.error, secrets);
    }
    return out;
  });
}
