import {
  AwakeBudget,
  EngagementDeniedError,
  type GezelConfig,
  type ScriptCapability,
  type ScriptMeta,
  ScriptMetaSchema,
  ScriptNameSchema,
  type ScriptRun,
  type ScriptRunCall,
  ScriptRunSchema,
  type ScriptRunTrigger,
  ScriptRunTriggerSchema,
  type ScriptScope,
  acquireSuspendMonitor,
  assertScriptExecutionAllowed,
  assertScriptMethodAllowed,
  getEngagementMode,
  isEngagementAllowed,
  narrowScriptSecurityCapabilities,
  validateScriptInput,
  validateScriptOutput,
} from '@bendyline/gezel';
import type { PortableScriptTaskContext } from '@bendyline/gezel/runtime';
import type { ScriptExecutor } from './index.js';

export interface PortableScriptDefinition {
  /** JavaScript compiled and metadata extracted by the trusted build, never by the guest. */
  source: string;
  meta: ScriptMeta;
  scope: ScriptScope;
  /** Original source and stable build hash for the shared read-only editor. */
  originalSource?: string;
  hash?: string;
  sourceCraftbook?: ScriptRun['sourceCraftbook'];
}

export interface PortableScriptContext extends PortableScriptTaskContext {
  projectId: string;
  runId: string;
  scriptName: string;
  signal: AbortSignal;
  trigger: ScriptRunTrigger;
}

export interface PortableScriptRunnerOptions {
  executor: ScriptExecutor;
  resolve(
    name: string,
    scope: ScriptScope,
    context: { projectId: string; trigger: ScriptRunTrigger },
  ): Promise<PortableScriptDefinition>;
  readConfig(): Promise<GezelConfig>;
  workspaceWriteAllowed(projectId: string): Promise<{ ok: boolean; reason?: string }>;
  /** Host must enforce path confinement and recheck mutable policy before effects. */
  dispatch(context: PortableScriptContext, method: string, params: unknown): Promise<unknown>;
  /** Must atomically save the ordinary ScriptRun record; failure prevents the next effect. */
  persistRun(run: ScriptRun): Promise<void>;
  now?(): number;
  createId?(): string;
}

export interface RunPortableScriptOptions {
  projectId: string;
  scriptName: string;
  scope?: ScriptScope;
  inputs?: Record<string, unknown>;
  trigger: ScriptRunTrigger;
  signal?: AbortSignal;
  timeoutMs?: number;
  depth?: number;
}

const MAX_LOG_CHARS = 64_000;
const MAX_RUN_CHARS = 2_000_000;
interface ActiveScript {
  projectId: string;
  depth: number;
  budget: AwakeBudget;
  signal: AbortSignal;
  trigger: ScriptRunTrigger;
  checkPolicy(): Promise<GezelConfig>;
}

/** The same SDK, schemas, validation and permission rules as the desktop ScriptRunner. */
export class PortableScriptRunner {
  private readonly active = new Map<string, ActiveScript>();
  constructor(private readonly host: PortableScriptRunnerOptions) {}

  async run(options: RunPortableScriptOptions): Promise<ScriptRun> {
    const releaseMonitor = acquireSuspendMonitor();
    try {
      return await this.runScoped(options);
    } finally {
      releaseMonitor();
    }
  }
  private async runScoped(
    options: RunPortableScriptOptions,
    hostParent?: { id: string; entry: ActiveScript },
  ): Promise<ScriptRun> {
    const { host } = this;
    const now = host.now ?? Date.now;
    const scope = options.scope ?? 'project';
    const parent =
      hostParent?.entry ??
      (options.trigger.kind === 'nested'
        ? this.active.get(options.trigger.parentRunId)
        : undefined);
    if (hostParent) {
      if (this.active.get(hostParent.id) !== parent || parent?.projectId !== options.projectId)
        throw new Error('Parent task script execution has ended or changed project');
      await parent.checkPolicy();
    }
    if (options.trigger.kind === 'nested') {
      if (!parent) throw new Error('Parent script execution has ended');
      if (scope !== 'project' || options.projectId !== parent.projectId)
        throw new Error('Nested scripts must use their parent project and project scope');
      await parent.checkPolicy();
    }
    const depth = parent ? parent.depth + 1 : (options.depth ?? 0);
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > 4)
      throw new Error('nested script depth exceeded (max 4)');
    let timeoutMs = options.timeoutMs ?? 300_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 1_800_000)
      throw new Error('Invalid script timeout');
    if (parent) {
      timeoutMs = Math.min(timeoutMs, parent.budget.remainingMs());
      if (timeoutMs <= 0) throw new Error('Parent script execution timed out');
    }
    const budget = new AwakeBudget(timeoutMs);
    ScriptNameSchema.parse(options.scriptName);
    ScriptRunTriggerSchema.parse(options.trigger);
    const definition = await host.resolve(options.scriptName, scope, options);
    if (definition.scope !== scope) throw new Error('Script resolver returned a different scope');
    const meta = ScriptMetaSchema.parse(definition.meta);
    if (meta.name !== options.scriptName)
      throw new Error('Script metadata does not match its name');
    let inputs = options.inputs;
    if (options.trigger.kind === 'step') {
      inputs = { ...inputs };
      if (meta.inputs?.taskRef && inputs.taskRef === undefined)
        inputs.taskRef = options.trigger.taskRef;
      if (meta.inputs?.stepId && inputs.stepId === undefined)
        inputs.stepId = options.trigger.stepId;
    }
    const input = validateScriptInput(meta, inputs);
    const config = await host.readConfig();
    assertScriptExecutionAllowed(config, scope, options.trigger);
    const allowed = new Set<ScriptCapability>(meta.requires ?? []);
    const stripped = new Map<ScriptCapability, string>();
    const strip = (capability: ScriptCapability, reason: string) => {
      if (allowed.delete(capability)) stripped.set(capability, reason);
    };
    const narrowCapabilities = async (current: GezelConfig) => {
      narrowScriptSecurityCapabilities(current, allowed, stripped);
      if (allowed.has('workspace.write')) {
        const gate = await host.workspaceWriteAllowed(options.projectId);
        if (!gate.ok)
          strip(
            'workspace.write',
            gate.reason ?? 'gezel workspace writes are turned off for this project',
          );
      }
    };
    await narrowCapabilities(config);
    const run: ScriptRun = {
      id: host.createId?.() ?? crypto.randomUUID(),
      projectId: options.projectId,
      scriptName: options.scriptName,
      scope,
      ...(definition.hash ? { sourceHash: definition.hash } : {}),
      ...(definition.sourceCraftbook ? { sourceCraftbook: definition.sourceCraftbook } : {}),
      startedAt: new Date(now()).toISOString(),
      status: 'running',
      trigger: options.trigger,
      ...(hostParent ? { parentRunId: hostParent.id } : {}),
      inputs: input,
      calls: [],
      logs: '',
    };
    const controller = new AbortController();
    const abort = () => controller.abort();
    const signals = new Set(
      [options.signal, parent?.signal].filter((signal): signal is AbortSignal => !!signal),
    );
    for (const signal of signals) {
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
    const context: PortableScriptContext = {
      projectId: options.projectId,
      runId: run.id,
      scriptName: run.scriptName,
      signal: controller.signal,
      trigger: hostParent ? options.trigger : (parent?.trigger ?? options.trigger),
    };
    let accepting = true;
    let outputSeen = false;
    let output: unknown;
    let persistFailure: unknown;
    // A snapshot is captured before queuing; later mutations cannot change what was audited.
    let persistence = Promise.resolve();
    const persist = () => {
      const serialized = JSON.stringify(run);
      if (serialized.length > MAX_RUN_CHARS) throw new Error('Script run record is too large');
      const snapshot = ScriptRunSchema.parse(JSON.parse(serialized));
      persistence = persistence.then(() => host.persistRun(snapshot));
      persistence.catch((error: unknown) => {
        persistFailure = error;
        controller.abort();
      });
      return persistence;
    };
    const checkActive = () => {
      if (!accepting || controller.signal.aborted) throw new Error('Script execution has ended');
      if (budget.expired())
        throw new Error(`script timed out after ${timeoutMs}ms${budget.describeSuspension()}`);
      if (persistFailure) throw persistFailure;
    };
    const checkPolicy = async () => {
      checkActive();
      await parent?.checkPolicy();
      const current = await host.readConfig();
      assertScriptExecutionAllowed(current, scope, options.trigger);
      await narrowCapabilities(current);
      checkActive();
      return current;
    };
    context.authorizeMethod = async (method) => {
      await checkPolicy();
      assertScriptMethodAllowed(method, allowed, stripped);
    };
    const log = (value: string) => {
      run.logs = (run.logs + value).slice(-MAX_LOG_CHARS);
    };
    const pending = new Set<ScriptRunCall>();
    const effects = new Set<Promise<unknown>>();
    let childRunning = false;
    const runChild = async (params: unknown) => {
      if (!params || typeof params !== 'object' || Array.isArray(params))
        throw new Error('Invalid nested script request');
      const args = params as Record<string, unknown>;
      if (Object.keys(args).some((key) => key !== 'name' && key !== 'input'))
        throw new Error('Nested scripts accept only a name and input');
      const name = ScriptNameSchema.parse(args.name);
      if (
        args.input !== undefined &&
        (!args.input || typeof args.input !== 'object' || Array.isArray(args.input))
      )
        throw new Error('Nested script input must be an object');
      if (childRunning) throw new Error('Wait for the current nested script to finish');
      childRunning = true;
      try {
        const child = await this.run({
          projectId: run.projectId,
          scriptName: name,
          scope: 'project',
          inputs: args.input as Record<string, unknown> | undefined,
          trigger: { kind: 'nested', parentRunId: run.id },
          signal: controller.signal,
          timeoutMs: Math.max(1, budget.remainingMs()),
        });
        return {
          runId: child.id,
          status: child.status === 'ok' ? ('ok' as const) : ('error' as const),
          output: child.output,
          error: child.error,
        };
      } finally {
        childRunning = false;
      }
    };
    const active: ActiveScript = {
      projectId: run.projectId,
      depth,
      budget,
      signal: controller.signal,
      trigger: context.trigger,
      checkPolicy,
    };
    this.active.set(run.id, active);
    context.runTaskScript = async (request) => {
      checkActive();
      if (request.trigger.kind !== 'step') throw new Error('Expected a host-owned task script');
      if (childRunning) throw new Error('Wait for the current nested script to finish');
      childRunning = true;
      try {
        return await this.runScoped(
          {
            ...request,
            projectId: run.projectId,
            timeoutMs: Math.max(1, budget.remainingMs()),
          },
          { id: run.id, entry: active },
        );
      } finally {
        childRunning = false;
      }
    };
    try {
      // Initial admission is durable even if the application is killed during startup.
      await persist();
      checkActive();
      const result = await host.executor.execute({
        source: definition.source,
        scriptName: run.scriptName,
        timeoutMs,
        init: {
          input,
          runId: run.id,
          projectId: run.projectId,
          engagementMode: getEngagementMode(config),
          engagementFlags: { llmAllowed: isEngagementAllowed(config) },
        },
        signal: controller.signal,
        provenanceTrusted: scope === 'standard',
        trustedReadOnlyStandard:
          scope === 'standard' && [...allowed].every((cap) => cap.endsWith('.read')),
        onRequest: async (method, params) => {
          checkActive();
          if (run.calls.length >= 1_000) throw new Error('Script host call limit exceeded');
          const start = now();
          const call: ScriptRunCall = {
            at: new Date(start).toISOString(),
            kind: method,
            argsSummary: summarize(params),
            durationMs: 0,
          };
          run.calls.push(call);
          pending.add(call);
          try {
            assertScriptMethodAllowed(method, allowed, stripped);
            call.error =
              'Host operation started; if interrupted, its outcome must be checked before retrying';
            await persist();
            checkActive();
            // Admission is a ceiling, never a lasting grant: policy may change while
            // the worker runs or while its durable call intent is being saved.
            const current = await checkPolicy();
            assertScriptMethodAllowed(method, allowed, stripped);
            if (method === 'llm.oneShot' && !isEngagementAllowed(current))
              throw new EngagementDeniedError(method);
            checkActive();
            const effect =
              method === 'script.run' ? runChild(params) : host.dispatch(context, method, params);
            effects.add(effect);
            let value: unknown;
            try {
              value = await effect;
            } finally {
              effects.delete(effect);
            }
            if (accepting) {
              delete call.error;
              call.outputSummary = summarize(value);
            }
            return value;
          } catch (error) {
            if (accepting) call.error = errorMessage(error);
            throw error;
          } finally {
            pending.delete(call);
            if (accepting) {
              call.durationMs = Math.max(0, now() - start);
              await persist();
            }
          }
        },
        onNotification: (method, params) => {
          checkActive();
          if (method === 'script.output') {
            if (outputSeen) throw new Error('Script output was already stamped');
            outputSeen = true;
            output = (params as { value?: unknown } | undefined)?.value;
          } else if (method === 'script.log') {
            const args = (params as { args?: unknown } | undefined)?.args;
            if (!Array.isArray(args)) throw new Error('Invalid script log');
            log(`${args.map((arg) => summarize(arg, 2_000)).join(' ')}\n`);
          } else throw new Error('Invalid script notification');
        },
        onStdout: (line) => log(`[stdout] ${line}\n`),
        onStderr: (line) => log(`[stderr] ${line}\n`),
      });
      if (persistFailure) throw persistFailure;
      if (controller.signal.aborted) throw new Error('Script execution cancelled');
      if (budget.expired())
        throw new Error(`script timed out after ${timeoutMs}ms${budget.describeSuspension()}`);
      if (result.timedOut) throw new Error(`script timed out after ${timeoutMs}ms`);
      if (result.exitCode !== 0)
        throw new Error(result.stderr || `script exited with code ${result.exitCode}`);
      if (meta.outputs && !outputSeen)
        throw new Error('Script finished without declaring its output');
      if (outputSeen) run.output = validateScriptOutput(meta, output);
      run.status = 'ok';
    } catch (error) {
      run.status = 'error';
      run.error = errorMessage(error);
    } finally {
      accepting = false;
      controller.abort();
      for (const signal of signals) signal.removeEventListener('abort', abort);
      // Termination revokes new calls; already-dispatched file operations must settle
      // before the host releases its admission lock or starts another run.
      await Promise.allSettled([...effects]);
      this.active.delete(run.id);
      for (const call of pending) {
        call.durationMs = Math.max(0, now() - Date.parse(call.at));
        call.error =
          'Script execution ended while this host operation was pending; it may still complete. Check its outcome before retrying.';
      }
      run.finishedAt = new Date(now()).toISOString();
    }
    // Persistence failures are surfaced; never claim completion with only an in-memory audit.
    if (persistFailure) throw persistFailure;
    await persist();
    return run;
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 8_000);
}
function summarize(value: unknown, max = 256): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value).slice(0, max);
  } catch {
    return String(value).slice(0, max);
  }
}
