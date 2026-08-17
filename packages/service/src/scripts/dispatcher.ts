import { randomUUID } from 'node:crypto';
import type {
  CreateTaskRequest,
  ScriptCapability,
  TaskCraftbookStep,
  UpdateTaskRequest,
} from '@bendyline/gezel';
import type { ChatManager } from '../chat/manager.js';
import type { Store } from '../fs/store.js';
import { isMemoryKind } from '../memory/daily-markdown.js';
import type { MemoryManager } from '../memory/manager.js';
import { resolveCredentialOriginPolicy } from '../secrets/origins.js';
import type { CredentialRegistry } from '../secrets/registry.js';
import type { TaskManager } from '../tasks/manager.js';
import { assertPublicUrl } from '../utils/ssrf.js';

const SCRIPT_HTTP_TIMEOUT_MS = 30_000;
const SCRIPT_HTTP_MAX_RESPONSE_BYTES = 1_000_000;

/**
 * The dispatcher maps RPC method names (`fs.read`, `llm.oneShot`,
 * `mcp.call`, etc.) to concrete service calls. Each method declares
 * the capability it requires; the runner checks the script's
 * `meta.requires` list before forwarding.
 *
 * `mcp.call` is a best-effort escape hatch: it looks up the tool on
 * the shared MCP surface and invokes it. Until the MCP slice lands,
 * `mcp.call` rejects with a typed error.
 */

export interface DispatcherContext {
  projectId: string;
  runId: string;
  /** Name of the running script. Used for audit events. */
  scriptName: string;
  engagementFlags: {
    llmAllowed: boolean;
  };
  allowedCapabilities: Set<ScriptCapability>;
  /**
   * Capabilities the script DID declare in `meta.requires` but a runtime
   * gate stripped (per-project workspace writes off, security policy),
   * mapped to a human-actionable reason. Lets the capability error tell
   * the truth — "declared but denied by X" instead of the misleading
   * "did not declare it in meta.requires" (which the script editor turns
   * into a wrong one-click add-the-capability fix).
   */
  strippedCapabilities?: Map<ScriptCapability, string>;
  /**
   * Secret values seen during this run that should be scrubbed from
   * any model-visible output. Populated lazily by handlers that
   * resolve credentials (e.g. `http.authed`) so the runner can do a
   * final redaction pass before returning / persisting the
   * `ScriptRun`. Starts empty; callers must never add arbitrary
   * strings — only known secret values.
   */
  knownSecretValues: Set<string>;
}

export type DispatchHandler = (ctx: DispatcherContext, params: unknown) => Promise<unknown>;

export interface DispatcherDeps {
  store: Store;
  chat: ChatManager;
  /**
   * Optional. When provided, the `memory.*` methods forward to it.
   * Injected by `service.ts`; when omitted those calls return a typed
   * error rather than silently no-op'ing.
   */
  memory?: MemoryManager;
  /**
   * Optional. When provided, the mutating `task.*` methods
   * (`update`, `advance`, `create`, `writeNotes`, `readNotes`) forward
   * to it. Injected by `service.ts`; when omitted those calls return a
   * typed error.
   */
  tasks?: TaskManager;
  /**
   * Optional. When provided, `mcp.call` forwards to it. Injected by
   * `service.ts` once the MCP bridge is constructed; until then, calls
   * return a typed error.
   */
  mcpCall?: (ctx: DispatcherContext, tool: string, args: unknown) => Promise<unknown>;
  /**
   * Optional. Wired by ScriptRunner so `script.run` can recurse without
   * a circular import between runner and dispatcher.
   */
  runNested?: (
    parentCtx: DispatcherContext,
    name: string,
    input?: Record<string, unknown>,
  ) => Promise<{ runId: string; status: 'ok' | 'error'; output?: unknown; error?: string }>;
  /**
   * Optional. When provided, the dispatcher resolves `credential:<name>`
   * capabilities through it for the `http.authed` method. Scripts whose
   * `meta.requires` contains a `credential:<name>` still pass the
   * generic capability gate; this is the registry that produces the
   * actual value at call time.
   */
  credentials?: CredentialRegistry;
}

export class CapabilityDeniedError extends Error {
  readonly code = 'CAPABILITY_DENIED';
  constructor(capability: ScriptCapability, method: string, strippedReason?: string) {
    super(
      strippedReason
        ? `script attempted to call "${method}" (capability: ${capability}); the capability is declared in meta.requires but is currently denied: ${strippedReason}`
        : `script attempted to call "${method}" (capability: ${capability}) but did not declare it in meta.requires`,
    );
    this.name = 'CapabilityDeniedError';
  }
}

export class EngagementDeniedError extends Error {
  readonly code = 'ENGAGEMENT_DENIED';
  constructor(method: string) {
    super(`script called "${method}" but AI engagement mode is set to "off"`);
    this.name = 'EngagementDeniedError';
  }
}

interface ParamsShape {
  [k: string]: unknown;
}

function param<T = unknown>(params: unknown, key: string): T | undefined {
  if (!params || typeof params !== 'object') return undefined;
  return (params as ParamsShape)[key] as T | undefined;
}

function requireParam<T = unknown>(params: unknown, key: string): T {
  const v = param<T>(params, key);
  if (v === undefined) throw new Error(`missing required param "${key}"`);
  return v;
}

export function buildDispatcher(deps: DispatcherDeps): {
  handlers: Record<string, { capability: ScriptCapability | null; handler: DispatchHandler }>;
  dispatch: (ctx: DispatcherContext, method: string, params: unknown) => Promise<unknown>;
} {
  const { store, chat } = deps;

  const handlers: Record<
    string,
    { capability: ScriptCapability | null; handler: DispatchHandler }
  > = {
    'fs.read': {
      capability: 'workspace.read',
      handler: async (ctx, params) => {
        const path = requireParam<string>(params, 'path');
        const content = await store.readProjectWorkspaceFile(ctx.projectId, path);
        if (content === null) throw new Error(`file not found: ${path}`);
        return content;
      },
    },
    'fs.write': {
      capability: 'workspace.write',
      handler: async (ctx, params) => {
        await store.writeProjectWorkspaceFile(
          ctx.projectId,
          requireParam<string>(params, 'path'),
          requireParam<string>(params, 'content'),
        );
      },
    },
    'fs.list': {
      capability: 'workspace.read',
      handler: async (ctx, params) => {
        const path = param<string>(params, 'path') ?? '';
        return store.listProjectWorkspace(ctx.projectId, path);
      },
    },
    'fs.listAll': {
      capability: 'workspace.read',
      handler: async (ctx) => {
        const entries = await store.listProjectWorkspaceRecursive(ctx.projectId);
        return entries.filter((e) => !e.isDirectory).map((e) => e.path);
      },
    },
    'fs.stat': {
      capability: 'workspace.read',
      handler: async (ctx, params) => {
        const path = requireParam<string>(params, 'path');
        return store.statProjectWorkspacePath(ctx.projectId, path);
      },
    },
    'fs.rm': {
      capability: 'workspace.write',
      handler: async (ctx, params) => {
        await store.rmProjectWorkspacePath(ctx.projectId, requireParam<string>(params, 'path'));
      },
    },
    'fs.mkdir': {
      capability: 'workspace.write',
      handler: async (ctx, params) => {
        await store.mkdirProjectWorkspace(ctx.projectId, requireParam<string>(params, 'path'));
      },
    },
    'fs.rename': {
      capability: 'workspace.write',
      handler: async (ctx, params) => {
        await store.renameProjectWorkspacePath(
          ctx.projectId,
          requireParam<string>(params, 'from'),
          requireParam<string>(params, 'to'),
        );
      },
    },

    'artifact.read': {
      capability: 'artifacts.read',
      handler: async (ctx, params) => {
        const path = requireParam<string>(params, 'path');
        const content = await store.readProjectArtifact(ctx.projectId, path);
        if (content === null) throw new Error(`artifact not found: ${path}`);
        return content;
      },
    },
    'artifact.write': {
      capability: 'artifacts.write',
      handler: async (ctx, params) => {
        await store.writeProjectArtifact(
          ctx.projectId,
          requireParam<string>(params, 'path'),
          requireParam<string>(params, 'content'),
        );
      },
    },
    'artifact.list': {
      capability: 'artifacts.read',
      handler: async (ctx, params) => {
        const prefix = param<string>(params, 'prefix') ?? '';
        // Recursive listings are scoped to `prefix`, so a script reading one
        // connector corpus is not competing with the rest of the drawer for
        // the walker's entry budget. Paths stay drawer-root-relative either
        // way, so a result can go straight back into `artifact.read`.
        if (param<boolean>(params, 'recursive') === true) {
          return store.listProjectArtifactsRecursive(ctx.projectId, {
            ...(prefix ? { subpath: prefix } : {}),
          });
        }
        return store.listProjectArtifacts(ctx.projectId, prefix);
      },
    },
    'artifact.delete': {
      capability: 'artifacts.write',
      handler: async (ctx, params) => {
        await store.deleteProjectArtifact(ctx.projectId, requireParam<string>(params, 'path'));
      },
    },

    'document.read': {
      capability: 'documents.read',
      handler: async (_ctx, params) => {
        const name = requireParam<string>(params, 'name');
        const content = await store.readDocument(name);
        if (content === null) throw new Error(`document not found: ${name}`);
        return content;
      },
    },
    'document.write': {
      capability: 'documents.write',
      handler: async (_ctx, params) => {
        await store.writeDocument(
          requireParam<string>(params, 'name'),
          requireParam<string>(params, 'content'),
        );
      },
    },
    'document.list': {
      capability: 'documents.read',
      handler: async () => store.listDocuments(),
    },
    'document.delete': {
      capability: 'documents.write',
      handler: async (_ctx, params) => {
        await store.deleteDocument(requireParam<string>(params, 'name'));
      },
    },

    'task.get': {
      capability: 'tasks.read',
      handler: async (ctx, params) => {
        const ref = requireParam<string>(params, 'ref');
        const [projectId, numStr] = splitRef(ref, ctx);
        const task = await store.readTask(projectId, Number(numStr));
        if (!task) throw new Error(`task not found: ${ref}`);
        return task;
      },
    },
    'task.steps': {
      capability: 'tasks.read',
      handler: async (ctx, params) => {
        const ref = requireParam<string>(params, 'ref');
        const [projectId, numStr] = splitRef(ref, ctx);
        const task = await store.readTask(projectId, Number(numStr));
        if (!task) throw new Error(`task not found: ${ref}`);
        return task.craftbook.steps.map((s) => toTaskStep(s, task.activeStepId));
      },
    },
    'task.currentStep': {
      capability: 'tasks.read',
      handler: async (ctx, params) => {
        const ref = requireParam<string>(params, 'ref');
        const [projectId, numStr] = splitRef(ref, ctx);
        const task = await store.readTask(projectId, Number(numStr));
        if (!task) throw new Error(`task not found: ${ref}`);
        if (!task.activeStepId) return null;
        const step = task.craftbook.steps.find((s) => s.id === task.activeStepId);
        return step ? toTaskStep(step, task.activeStepId) : null;
      },
    },
    'task.update': {
      capability: 'tasks.write',
      handler: async (ctx, params) => {
        if (!deps.tasks) throw new Error('task.update is not available (no task manager wired)');
        const ref = requireParam<string>(params, 'ref');
        const patch = requireParam<Record<string, unknown>>(params, 'patch');
        const [projectId, numStr] = splitRef(ref, ctx);
        return deps.tasks.update(projectId, Number(numStr), patch as UpdateTaskRequest);
      },
    },
    'task.advance': {
      capability: 'tasks.write',
      handler: async (ctx, params) => {
        if (!deps.tasks) throw new Error('task.advance is not available (no task manager wired)');
        const ref = requireParam<string>(params, 'ref');
        const nextPhaseName = param<string>(params, 'nextPhaseName');
        const [projectId, numStr] = splitRef(ref, ctx);
        const num = Number(numStr);
        // "Advance" completes the task's currently-active step. Routing
        // (`nextPhaseName`) and completion gates are handled by the
        // manager exactly as they are for a user-driven completion;
        // `completeStepChecked` returns 'held' (rather than throwing)
        // when a gate rejects, so the script can react to that.
        const task = await store.readTask(projectId, num);
        if (!task) throw new Error(`task not found: ${ref}`);
        if (!task.activeStepId) throw new Error(`task ${ref} has no active step to advance`);
        return deps.tasks.completeStepChecked(projectId, num, task.activeStepId, nextPhaseName);
      },
    },
    'task.create': {
      capability: 'tasks.write',
      handler: async (ctx, params) => {
        if (!deps.tasks) throw new Error('task.create is not available (no task manager wired)');
        const req = requireParam<Record<string, unknown>>(params, 'req');
        return deps.tasks.create(ctx.projectId, req as CreateTaskRequest);
      },
    },
    // Note operations (`writeNotes`/`readNotes`/`appendNote`/`deleteNote`)
    // go straight to the store, so they work even when the task manager
    // isn't wired. `phaseId` in the SDK maps to a note's `stepId`.
    'task.writeNotes': {
      capability: 'tasks.write',
      handler: async (ctx, params) => {
        const ref = requireParam<string>(params, 'ref');
        const content = requireParam<string>(params, 'content');
        const phaseId = param<string>(params, 'phaseId');
        const [projectId, numStr] = splitRef(ref, ctx);
        await store.appendTaskNote(projectId, Number(numStr), {
          id: randomUUID().slice(0, 12),
          at: new Date().toISOString(),
          author: { kind: 'user' as const },
          ...(phaseId ? { stepId: phaseId } : {}),
          text: content,
        });
      },
    },
    'task.readNotes': {
      capability: 'tasks.read',
      handler: async (ctx, params) => {
        const ref = requireParam<string>(params, 'ref');
        const phaseId = param<string>(params, 'phaseId');
        const [projectId, numStr] = splitRef(ref, ctx);
        const notes = await store.listTaskNotes(projectId, Number(numStr), phaseId);
        return notes.map((n) => n.text).join('\n\n');
      },
    },
    // `appendNote` is the CRUD form of `writeNotes` — it returns the
    // created note (with its generated id/timestamp). `stepId` attaches
    // the note to a step.
    'task.appendNote': {
      capability: 'tasks.write',
      handler: async (ctx, params) => {
        const ref = requireParam<string>(params, 'ref');
        const text = requireParam<string>(params, 'text');
        const stepId = param<string>(params, 'stepId');
        const [projectId, numStr] = splitRef(ref, ctx);
        const note = {
          id: randomUUID().slice(0, 12),
          at: new Date().toISOString(),
          author: { kind: 'user' as const },
          ...(stepId ? { stepId } : {}),
          text,
        };
        await store.appendTaskNote(projectId, Number(numStr), note);
        return note;
      },
    },
    'task.deleteNote': {
      capability: 'tasks.write',
      handler: async (ctx, params) => {
        const ref = requireParam<string>(params, 'ref');
        const noteId = requireParam<string>(params, 'noteId');
        const [projectId, numStr] = splitRef(ref, ctx);
        return store.deleteTaskNote(projectId, Number(numStr), noteId);
      },
    },

    'memory.search': {
      capability: 'memory.read',
      handler: async (ctx, params) => {
        if (!deps.memory)
          throw new Error('memory.search is not available (no memory manager wired)');
        const query = requireParam<string>(params, 'query');
        return deps.memory.search('project', ctx.projectId, query);
      },
    },
    'memory.save': {
      capability: 'memory.write',
      handler: async (ctx, params) => {
        if (!deps.memory) throw new Error('memory.save is not available (no memory manager wired)');
        const text = requireParam<string>(params, 'text');
        // The SDK passes free-form `meta`; the only field the memory
        // store understands is `kind`. Honor it when it's a valid kind,
        // otherwise fall back to the manager's default.
        const meta = param<Record<string, unknown>>(params, 'meta');
        const kindRaw = typeof meta?.kind === 'string' ? meta.kind : undefined;
        const kind = isMemoryKind(kindRaw) ? kindRaw : undefined;
        return deps.memory.save('project', ctx.projectId, text, kind);
      },
    },

    'llm.oneShot': {
      capability: 'llm',
      handler: async (ctx, params) => {
        if (!ctx.engagementFlags.llmAllowed) {
          throw new EngagementDeniedError('llm.oneShot');
        }
        const prompt = requireParam<string>(params, 'prompt');
        const opts = (param<Record<string, unknown>>(params, 'opts') ?? {}) as {
          timeoutMs?: number;
          model?: string;
        };
        return chat.oneShotCompletion(prompt, opts.timeoutMs ?? 120_000, {
          model: opts.model,
          jobLabel: 'script · llm.oneShot',
        });
      },
    },

    'mcp.call': {
      capability: 'network',
      handler: async (ctx, params) => {
        const tool = requireParam<string>(params, 'tool');
        const args = param(params, 'args');
        if (!deps.mcpCall) {
          throw new Error('mcp.call is not yet wired into ScriptRunner');
        }
        return deps.mcpCall(ctx, tool, args);
      },
    },

    'http.request': {
      capability: 'network',
      handler: async (_ctx, params) => {
        const url = requireParam<string>(params, 'url');
        const method = param<string>(params, 'method') ?? 'GET';
        const body = param<string>(params, 'body');
        const headers = {
          ...((param<Record<string, string>>(params, 'headers') as Record<string, string>) ?? {}),
        };
        if (Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')) {
          throw new Error('http.request is anonymous; use http.authed for Authorization');
        }
        await assertPublicUrl(url);
        const init: RequestInit = { method, headers, redirect: 'manual' };
        if (body !== undefined) init.body = body;
        return fetchScriptHttp(url, init);
      },
    },

    'http.authed': {
      // Gated by TWO capabilities: the generic `network` tag (so a
      // no-network script can't reach out), plus the
      // `credential:<name>` matching the credential the script asked
      // for. The first is checked by the generic dispatcher gate
      // below; the second is checked inline because the name is
      // request-scoped.
      capability: 'network',
      handler: async (ctx, params) => {
        if (!deps.credentials) {
          throw new Error('http.authed is not available (no credential registry wired)');
        }
        const url = requireParam<string>(params, 'url');
        const credentialName = requireParam<string>(params, 'credential');
        const method = param<string>(params, 'method') ?? 'GET';
        const body = param<string>(params, 'body');
        const extraHeaders =
          (param<Record<string, string>>(params, 'headers') as Record<string, string>) ?? {};
        const auth = (param<string>(params, 'authScheme') ?? 'bearer') as 'bearer' | 'basic';

        const requiredCap = `credential:${credentialName}`;
        if (!ctx.allowedCapabilities.has(requiredCap)) {
          throw new CapabilityDeniedError(
            requiredCap,
            'http.authed',
            ctx.strippedCapabilities?.get(requiredCap),
          );
        }
        await assertCredentialOriginAllowed(store, ctx.projectId, credentialName, url);
        // Origin binding is checked before the secret is resolved, and
        // redirects remain manual so the Authorization header can never be
        // forwarded to a second origin implicitly.
        const value = await deps.credentials.resolve(credentialName, ctx.projectId, {
          kind: 'script',
          scriptName: ctx.scriptName,
          runId: ctx.runId,
        });
        // Register the value with the per-run scrub set so any echo in
        // the response body (or in our own error messages) is
        // redacted before results reach the model.
        ctx.knownSecretValues.add(value);

        const headers: Record<string, string> = { ...extraHeaders };
        if (auth === 'basic') {
          headers.Authorization = `Basic ${value}`;
        } else {
          headers.Authorization = `Bearer ${value}`;
        }

        const init: RequestInit = { method, headers, redirect: 'manual' };
        if (body !== undefined) init.body = body;

        return fetchScriptHttp(url, init);
      },
    },

    'script.run': {
      capability: null,
      handler: async (ctx, params) => {
        const name = requireParam<string>(params, 'name');
        const input = param<Record<string, unknown>>(params, 'input');
        if (!deps.runNested) throw new Error('nested script.run is not available');
        return deps.runNested(ctx, name, input);
      },
    },
  };

  async function dispatch(
    ctx: DispatcherContext,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    const entry = handlers[method];
    if (!entry) throw new Error(`unknown method "${method}"`);
    if (entry.capability && !ctx.allowedCapabilities.has(entry.capability)) {
      throw new CapabilityDeniedError(
        entry.capability,
        method,
        ctx.strippedCapabilities?.get(entry.capability),
      );
    }
    return entry.handler(ctx, params);
  }

  return { handlers, dispatch };
}

async function assertCredentialOriginAllowed(
  store: Store,
  projectId: string,
  credentialName: string,
  rawUrl: string,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('http.authed requires a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw new Error('http.authed refuses to send credentials over non-HTTPS connections');
  }
  if (url.username || url.password) {
    throw new Error('http.authed does not allow credentials embedded in the URL');
  }

  let originPolicy = resolveCredentialOriginPolicy(credentialName);
  if (originPolicy.source === 'webhook') {
    const config = await store.readConfig();
    originPolicy = resolveCredentialOriginPolicy(credentialName, {
      webhookUrl: config.channels?.webhook?.url,
    });
  } else if (originPolicy.source === 'project') {
    const project = await store.getProject(projectId);
    originPolicy = resolveCredentialOriginPolicy(credentialName, {
      projectOrigins: project?.credentialAllowedOrigins,
    });
  }

  const allowed = new Set(originPolicy.origins);
  if (!allowed.has(url.origin)) {
    throw new Error(
      `credential "${credentialName}" is not allowed for origin "${url.origin}". Configure the credential's HTTPS destination first.`,
    );
  }
  // Built-in providers stay public. Webhook and toolset destinations were
  // explicitly configured and may intentionally point at a self-hosted LAN
  // service, but remain pinned to that exact origin.
  if (!originPolicy.permitsPrivateNetwork) await assertPublicUrl(url.href);
}

async function fetchScriptHttp(
  url: string,
  init: RequestInit,
): Promise<{
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('script HTTP request timed out')),
    SCRIPT_HTTP_TIMEOUT_MS,
  );
  timeout.unref?.();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await readBoundedResponseText(response, SCRIPT_HTTP_MAX_RESPONSE_BYTES);
    return {
      status: response.status,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`script HTTP response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (err) {
    try {
      await reader.cancel(err);
    } catch {
      /* best effort */
    }
    throw err;
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

function splitRef(ref: string, ctx: DispatcherContext): [string, string] {
  const idx = ref.lastIndexOf('/');
  if (idx < 0) return [ctx.projectId, ref];
  const projectId = ref.slice(0, idx);
  // Cross-project task refs are intentionally supported, but the
  // projectId segment flows unsanitized into a filesystem path. A real
  // project id is a single slug (`slugify()` → [a-z0-9-]); reject path
  // separators and dot-segments so a crafted ref can't traverse out of
  // the projects root (`../../etc/passwd`, absolute paths, NUL).
  if (
    projectId.length === 0 ||
    projectId.includes('/') ||
    projectId.includes('\\') ||
    projectId.includes('\0') ||
    projectId === '.' ||
    projectId === '..'
  ) {
    throw new Error(`invalid project id in task ref "${ref}"`);
  }
  return [projectId, ref.slice(idx + 1)];
}

/**
 * Project a task's embedded craftbook step down to the curated, read-only
 * `TaskStep` view the SDK exposes — the internal routing machinery (gates,
 * branches, hook script refs) is dropped, and a lifecycle `status` is
 * derived from the task's `activeStepId` and the step's `completedAt`.
 */
function toTaskStep(step: TaskCraftbookStep, activeStepId: string | undefined) {
  const isActive = step.id === activeStepId;
  return {
    id: step.id,
    name: step.name,
    ...(step.description !== undefined ? { description: step.description } : {}),
    status: isActive ? 'active' : step.completedAt ? 'complete' : 'pending',
    isActive,
    ...(step.completedAt !== undefined ? { completedAt: step.completedAt } : {}),
    ...(step.attemptCount !== undefined ? { attemptCount: step.attemptCount } : {}),
    ...(step.terminal !== undefined ? { terminal: step.terminal } : {}),
  };
}
