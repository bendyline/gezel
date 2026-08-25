/**
 * `@bendyline/gezel-sdk` — imported by TypeScript scripts running in the
 * Gezel sandbox. Exposes the `gezel` object (typed proxy over the fd-3
 * RPC channel) and `defineScript` (type helper for meta declarations).
 *
 * This module's top-level side effect is to read the init payload from
 * stdin synchronously, so `gezel.input` is available to the first line
 * of user code.
 */

import type { IndexReadinessReport, WorkspaceIndexStatus } from '@bendyline/gezel';
import { RpcClient } from './rpc.js';
import type { InferInput, InferOutput, ScriptInputs, ScriptMeta, ScriptOutputs } from './types.js';

export * from './types.js';

/**
 * Type-only helper that preserves the descriptor and lets downstream
 * type inference (on `gezel.input` / the chained `gezel.output` payload)
 * read it. Pass `as const` to get literal inference on choice options.
 */
export function defineScript<
  I extends ScriptInputs | undefined,
  O extends ScriptOutputs | undefined,
>(meta: ScriptMeta<I, O>): ScriptMeta<I, O> {
  return meta;
}

const rpc = new RpcClient();
let outputStamped = false;

/** A single entry returned by {@link GezelSDK.fs | `gezel.fs.list`}. */
export interface FsEntry {
  /** Base name of the entry (not the full path), e.g. `index.html`. */
  name: string;
  /** `true` for directories, `false` for regular files. */
  isDirectory: boolean;
  /** Size in bytes. `0` for directories. */
  size: number;
  /** Last-modified time as an ISO-8601 timestamp. */
  modified: string;
}

/** Metadata returned by {@link GezelSDK.fs | `gezel.fs.stat`}. */
export interface FsStat {
  /** Size in bytes. */
  size: number;
  /** Last-modified time as an ISO-8601 timestamp. */
  modified: string;
  /** `true` if the path is a directory. */
  isDirectory: boolean;
  /** `true` if the path is a regular file. */
  isFile: boolean;
}

/** A single entry returned by {@link GezelSDK.artifacts | `gezel.artifacts.list`}. */
export interface ArtifactEntry {
  /** Artifact path relative to the project's artifact store. */
  path: string;
  /** Size in bytes. */
  size: number;
  /** Last-modified time as an ISO-8601 timestamp. */
  modified: string;
}

/** A single entry returned by {@link GezelSDK.documents | `gezel.documents.list`}. */
export interface DocumentEntry {
  /** Document name (its key in the shared document store). */
  name: string;
  /** Size in bytes. */
  size: number;
  /** Last-modified time as an ISO-8601 timestamp. */
  modified: string;
}

/** Options for {@link GezelSDK.llm | `gezel.llm.oneShot`}. */
export interface OneShotOpts {
  /**
   * Hard timeout for the completion, in milliseconds. The call rejects
   * if the model has not finished within this window. Defaults to
   * `120000` (2 minutes).
   */
  timeoutMs?: number;
  /**
   * Override the model used for this single call (e.g. `'gemma-12b'`).
   * When omitted, the project's configured default model is used.
   */
  model?: string;
}

/** Options for an unauthenticated {@link GezelSDK.http} request. */
export interface HttpRequestOpts {
  /** HTTP method. Defaults to `'GET'`. */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Raw request body, already serialized. */
  body?: string;
  /** Extra headers. Anonymous requests reject `Authorization`. */
  headers?: Record<string, string>;
}

/** Options for {@link GezelSDK.http | `gezel.http.authed`}. */
export interface AuthedHttpOpts {
  /**
   * Short credential name. The script must declare `credential:<name>`
   * in `meta.requires`, and the project must have granted access to it.
   * The service resolves this to a raw secret at dispatch time and
   * attaches the auth header — the script never sees the secret value.
   */
  credential: string;
  /** HTTP method. Defaults to `'GET'`. */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Raw request body (already serialized — e.g. a JSON string). */
  body?: string;
  /**
   * Extra request headers. The `Authorization` header is added by the
   * service from the resolved credential and will override any value
   * you set here.
   */
  headers?: Record<string, string>;
  /**
   * How the credential is attached to the `Authorization` header:
   * `'bearer'` → `Bearer <value>`, `'basic'` → `Basic <value>`.
   * Defaults to `'bearer'`.
   */
  authScheme?: 'bearer' | 'basic';
}

/** The response returned by {@link GezelSDK.http | `gezel.http.authed`}. */
export interface AuthedHttpResponse {
  /** HTTP status code (e.g. `200`, `404`). */
  status: number;
  /** `true` when `status` is in the 2xx range. */
  ok: boolean;
  /** Response headers, lower-cased keys. */
  headers: Record<string, string>;
  /**
   * Response body as text. Any occurrence of the resolved credential
   * value is scrubbed before the body reaches the script. Parse with
   * `JSON.parse(res.body)` when you expect JSON.
   */
  body: string;
}

/** Response returned by unauthenticated and credentialed HTTP requests. */
export type HttpResponse = AuthedHttpResponse;

/**
 * A single step of a task's craftbook, as returned by
 * {@link GezelSDK.task | `gezel.task.steps`} and `gezel.task.currentStep`.
 * This is a curated, read-only view — the internal routing machinery
 * (gates, branches, hook script refs) is intentionally omitted.
 */
export interface TaskStep {
  /** Stable step id — the value used as `phaseId` / routing `goto` elsewhere. */
  id: string;
  /** Human-readable step name. */
  name: string;
  /** Optional longer description of what the step is for. */
  description?: string;
  /**
   * Lifecycle status derived from the task's state: the currently-active
   * step is `'active'`, a step that has been completed is `'complete'`,
   * and any step not yet reached is `'pending'`. (On a loop-back the
   * re-activated step reports `'active'` again.)
   */
  status: 'pending' | 'active' | 'complete';
  /** `true` if this is the task's currently-active step. */
  isActive: boolean;
  /** ISO-8601 timestamp of when the step completed, if it has. */
  completedAt?: string;
  /**
   * How many times this step has been activated. A linear run touches a
   * step once; a looping craftbook re-activates it each pass, so the
   * count climbs. Absent until the step first activates.
   */
  attemptCount?: number;
  /** `true` if this is a terminal step (no further routing after it). */
  terminal?: boolean;
}

/** Who authored a {@link TaskNote}. */
export type TaskNoteAuthor = { kind: 'user' } | { kind: 'gezel'; gezelId: string; name: string };

/** A single note on a task, as returned by `gezel.task.appendNote`. */
export interface TaskNote {
  /** Stable note id (pass to `gezel.task.deleteNote`). */
  id: string;
  /** ISO-8601 timestamp of when the note was written. */
  at: string;
  /** Who wrote the note. Notes written by scripts are authored as the user. */
  author: TaskNoteAuthor;
  /** The step this note is attached to, if any. */
  stepId?: string;
  /** The note text. */
  text: string;
}

/** The result of a nested {@link GezelSDK.script | `gezel.script.run`} call. */
export interface ScriptResult<TOutput = unknown> {
  /** Unique id of the nested run, useful for correlating trace logs. */
  runId: string;
  /** `'ok'` if the nested script completed; `'error'` if it threw. */
  status: 'ok' | 'error';
  /**
   * The value the nested script stamped via `gezel.output(...)`.
   * Present only when `status === 'ok'`. Pass a type argument to
   * `script.run<T>()` to type this field.
   */
  output?: TOutput;
  /** Error message when `status === 'error'`; otherwise absent. */
  error?: string;
}

/**
 * The `gezel` object — the single entry point a script uses to reach the
 * sandbox host. Every method is a typed proxy over the fd-3 RPC channel;
 * each namespace (`fs`, `artifact`, `task`, …) maps to a capability that
 * must be declared in the script's `meta.requires` (see
 * {@link ScriptCapability}). Calling a method whose capability was not
 * declared rejects with a `CAPABILITY_DENIED` error.
 *
 * @typeParam TInput - Shape of {@link GezelSDK.input | `gezel.input`}.
 *   Narrow it with {@link InferredInput} from your `defineScript` meta.
 *
 * @example Read a file, ask the model about it, and stamp the result:
 * ```ts
 * import { gezel, defineScript, type InferredInput } from '@bendyline/gezel-sdk';
 *
 * export const meta = defineScript({
 *   name: 'summarize-readme',
 *   description: 'Summarize the project README.',
 *   inputs: { path: { type: 'string', description: 'File to read', default: 'README.md' } },
 *   outputs: { summary: { type: 'string', description: 'One-paragraph summary' } },
 *   requires: ['workspace.read', 'llm'],
 * } as const);
 *
 * const input = gezel.input as InferredInput<typeof meta>;
 * const text = await gezel.fs.read(input.path ?? 'README.md');
 * const summary = await gezel.llm.oneShot(`Summarize:\n\n${text}`);
 * gezel.output({ summary });
 * ```
 */
export interface GezelSDK<TInput = Record<string, unknown>> {
  /**
   * Parsed and validated input for this run, populated from the init
   * payload before the first line of user code executes. Cast it to a
   * precise type with {@link InferredInput} for full autocomplete:
   *
   * ```ts
   * const input = gezel.input as InferredInput<typeof meta>;
   * ```
   */
  readonly input: TInput;

  /**
   * Stamp the script's final output. **Call exactly once per run** —
   * a second call throws. For a `gate` script, pass a
   * {@link GateScriptResult}; for an `action` script, pass the object
   * described by `meta.outputs`.
   *
   * @param value - The result payload to record for this run.
   */
  output(value: unknown): void;

  /**
   * Emit a structured log line, captured as part of the ScriptRun
   * trace and also mirrored to stderr. Use it for progress and
   * debugging; it does not affect the script's output.
   *
   * @param args - Values to log. Non-strings are JSON-stringified.
   */
  log(...args: unknown[]): void;

  /**
   * Project **workspace** files (the editable source tree). Paths are
   * relative to the workspace root and sandboxed — they cannot escape
   * it. Requires `workspace.read` for reads and `workspace.write` for
   * writes.
   *
   * @example
   * ```ts
   * const files = await gezel.fs.listAll();
   * const html = await gezel.fs.read('index.html');
   * await gezel.fs.write('out/notes.md', '# Notes\n');
   * ```
   */
  fs: {
    /**
     * Read a workspace file as UTF-8 text.
     * @param path - Workspace-relative path.
     * @returns The file contents.
     * @throws If the file does not exist (`file not found: <path>`).
     */
    read(path: string): Promise<string>;
    /**
     * Write a workspace file, creating parent directories as needed
     * and overwriting any existing file.
     * @param path - Workspace-relative path.
     * @param content - UTF-8 text to write.
     */
    write(path: string, content: string): Promise<void>;
    /**
     * List the immediate children of a directory (non-recursive).
     * @param path - Workspace-relative directory; defaults to the root.
     * @returns Entries for files and subdirectories.
     */
    list(path: string): Promise<FsEntry[]>;
    /**
     * Relative paths of ALL workspace files (recursive, one
     * round-trip). Directories are omitted. Prefer this over walking
     * {@link list} yourself.
     */
    listAll(): Promise<string[]>;
    /**
     * Stat a workspace path.
     * @param path - Workspace-relative path.
     * @returns Size, mtime, and file/directory flags.
     */
    stat(path: string): Promise<FsStat>;
    /**
     * Remove a workspace file.
     * @param path - Workspace-relative path.
     */
    rm(path: string): Promise<void>;
    /**
     * Create a directory in the workspace.
     * @param path - Workspace-relative path.
     * @remarks {@link write} already creates parent directories, so this
     *   is only needed to materialize an empty directory.
     */
    mkdir(path: string): Promise<void>;
    /**
     * Rename / move a workspace file.
     * @param from - Existing workspace-relative path.
     * @param to - Destination workspace-relative path.
     */
    rename(from: string, to: string): Promise<void>;
  };

  /**
   * Project **artifacts** — generated output files kept separately from
   * the editable workspace (build products, reports, exports). Requires
   * `artifacts.read` / `artifacts.write`.
   */
  artifacts: {
    /**
     * Read an artifact as UTF-8 text.
     * @throws If the artifact does not exist (`artifact not found: <path>`).
     */
    read(path: string): Promise<string>;
    /** Write (or overwrite) an artifact. */
    write(path: string, content: string): Promise<void>;
    /**
     * List artifacts in one directory of the drawer, or a whole subtree.
     * @param prefix - Directory to list (default: the drawer root).
     * @param opts.recursive - Walk the subtree under `prefix` instead of one
     *   level. Returned paths stay relative to the drawer root, so they can
     *   be passed straight back to {@link read}. Large subtrees are capped by
     *   the walker's entry budget; scope `prefix` to stay inside it.
     */
    list(prefix?: string, opts?: { recursive?: boolean }): Promise<ArtifactEntry[]>;
    /** Delete an artifact. */
    delete(path: string): Promise<void>;
  };

  /**
   * Shared **documents** — a project-independent key/value store of
   * named text documents. Requires `documents.read` / `documents.write`.
   */
  documents: {
    /**
     * Read a document by name.
     * @throws If the document does not exist (`document not found: <name>`).
     */
    read(name: string): Promise<string>;
    /** Write (or overwrite) a document by name. */
    write(name: string, content: string): Promise<void>;
    /** List all documents. */
    list(): Promise<DocumentEntry[]>;
    /** Delete a document by name. */
    delete(name: string): Promise<void>;
  };

  /**
   * **Tasks** — read, mutate, and annotate the project's task records.
   * The `ref` is either `"<num>"` (a task number in the current project)
   * or `"<projectId>/<num>"` to reach another project. Requires
   * `tasks.read` for reads and `tasks.write` for mutations.
   */
  task: {
    /**
     * Fetch a task record.
     * @param ref - `"<num>"` or `"<projectId>/<num>"`.
     * @returns The full task object.
     * @throws If the task does not exist (`task not found: <ref>`).
     */
    get(ref: string): Promise<unknown>;
    /**
     * List all steps of the task's craftbook, in order, each with its
     * derived {@link TaskStep.status | status}.
     * @param ref - `"<num>"` or `"<projectId>/<num>"`.
     * @returns The task's steps as curated {@link TaskStep} views.
     *
     * @example
     * ```ts
     * const steps = await gezel.task.steps('7');
     * const done = steps.filter((s) => s.status === 'complete').length;
     * gezel.log(`progress: ${done}/${steps.length}`);
     * ```
     */
    steps(ref: string): Promise<TaskStep[]>;
    /**
     * Get the task's currently-active step.
     * @param ref - `"<num>"` or `"<projectId>/<num>"`.
     * @returns The active {@link TaskStep}, or `null` if no step is active.
     */
    currentStep(ref: string): Promise<TaskStep | null>;
    /**
     * Patch fields on a task (e.g. `title`, `description`, `plan`,
     * `assignee`).
     * @param ref - `"<num>"` or `"<projectId>/<num>"`.
     * @param patch - Partial set of task fields to update.
     * @returns The updated task object.
     */
    update(ref: string, patch: Record<string, unknown>): Promise<unknown>;
    /**
     * Complete the task's currently-active step, advancing the craftbook.
     * Completion gates run as usual; if a gate holds the step the call
     * resolves with a `held` outcome rather than throwing.
     * @param ref - `"<num>"` or `"<projectId>/<num>"`.
     * @param nextPhaseName - Optional step to route to, overriding the
     *   craftbook's default next step.
     * @returns The completion outcome (`{ status, task, gate? }`).
     * @throws If the task has no active step to advance.
     */
    advance(ref: string, nextPhaseName?: string): Promise<unknown>;
    /**
     * Append a note to a task (fire-and-forget). Use {@link appendNote}
     * instead when you need the created note back.
     * @param ref - `"<num>"` or `"<projectId>/<num>"`.
     * @param content - The note text.
     * @param phaseId - Optional step id to attach the note to.
     */
    writeNotes(ref: string, content: string, phaseId?: string): Promise<void>;
    /**
     * Append a note to a task and return it — the convenient CRUD form of
     * {@link writeNotes}, handy when you want the generated `id`/`at`.
     * @param ref - `"<num>"` or `"<projectId>/<num>"`.
     * @param text - The note text.
     * @param stepId - Optional step id to attach the note to.
     * @returns The created note.
     */
    appendNote(ref: string, text: string, stepId?: string): Promise<TaskNote>;
    /**
     * Read a task's notes as a single string (note bodies joined by
     * blank lines).
     * @param ref - `"<num>"` or `"<projectId>/<num>"`.
     * @param phaseId - Optional step id to filter notes by.
     * @returns The concatenated note text (empty string if none).
     */
    readNotes(ref: string, phaseId?: string): Promise<string>;
    /**
     * Delete a note from a task by id.
     * @param ref - `"<num>"` or `"<projectId>/<num>"`.
     * @param noteId - The id of the note to remove.
     * @returns The removed note, or `null` if no note with that id existed.
     */
    deleteNote(ref: string, noteId: string): Promise<TaskNote | null>;
    /**
     * Create a new task in the current project.
     * @param req - The create-task request (title, description, craftbook
     *   selection, assignee, …).
     * @returns The newly created task object.
     */
    create(req: Record<string, unknown>): Promise<unknown>;
  };

  /**
   * **Memory** — semantic store of prior learnings. Requires
   * `memory.read` / `memory.write`.
   *
   * @example
   * ```ts
   * const hits = await gezel.memory.search('how we handle auth') as
   *   { text: string; score: number }[];
   * await gezel.memory.save('Auth uses bearer tokens from the registry.');
   * ```
   */
  memory: {
    /**
     * Semantic search over the project's saved memories.
     * @param query - Natural-language query.
     * @returns Ranked hits, each `{ text, score, day, scope, id, kind }`
     *   (highest score first).
     */
    search(query: string): Promise<unknown[]>;
    /**
     * Save a memory to the project's store. Near-duplicate text is
     * skipped automatically.
     * @param text - The fact to remember.
     * @param meta - Optional metadata. A `kind` of `'fact'` |
     *   `'decision'` | `'pref'` | `'status'` categorizes the memory;
     *   other fields are ignored.
     */
    save(text: string, meta?: Record<string, unknown>): Promise<void>;
  };

  /**
   * **LLM** — one-shot model completions. Requires the `llm` capability,
   * and the project's AI engagement mode must not be `off` (otherwise
   * the call rejects with an engagement error).
   */
  llm: {
    /**
     * Run a single prompt to completion and return the text.
     * @param prompt - The full prompt to send.
     * @param opts - Optional timeout / model override; see {@link OneShotOpts}.
     * @returns The model's text response.
     *
     * @example
     * ```ts
     * const answer = await gezel.llm.oneShot('Name three primary colors.');
     * ```
     */
    oneShot(prompt: string, opts?: OneShotOpts): Promise<string>;
  };

  /**
   * **MCP** — escape hatch to invoke any tool on the shared MCP surface
   * (e.g. GitHub, web fetch). Requires the `network` capability.
   */
  mcp: {
    /**
     * Invoke an MCP tool by name.
     * @param tool - Tool name, e.g. `'github_pr_create'`.
     * @param args - Tool arguments (tool-specific shape).
     * @returns The tool's raw result.
     *
     * @example
     * ```ts
     * const res = await gezel.mcp.call('github_pr_create', {
     *   title: 'My change', body: '...', base: 'main',
     * });
     * ```
     */
    call(tool: string, args: unknown): Promise<unknown>;
  };

  /**
   * Credentialed HTTP. The script names the credential it wants to
   * use — the service resolves the value, attaches auth, and returns
   * only the response body + headers. The raw credential value
   * NEVER enters the script's address space.
   *
   * Scripts must declare `credential:<name>` in `meta.requires` for
   * every credential they intend to use (in addition to `network`); the
   * target project must have explicitly granted access to the
   * credential. Missing grants, missing stored values, and missing
   * capability declarations each produce distinct typed errors.
   *
   * @example
   * ```ts
   * const res = await gezel.http.authed('https://api.example.com/me', {
   *   credential: 'example-token',
   * });
   * if (res.ok) {
   *   const me = JSON.parse(res.body);
   * }
   * ```
   */
  http: {
    /**
     * Perform an unauthenticated HTTP request through the sandbox host.
     * Redirects are returned without being followed.
     */
    request(url: string, opts?: HttpRequestOpts): Promise<HttpResponse>;
    /**
     * Perform an authenticated HTTP request.
     * @param url - Absolute URL to request.
     * @param opts - Method, body, headers, and the credential to use;
     *   see {@link AuthedHttpOpts}.
     * @returns Status, headers, and the (secret-scrubbed) body.
     */
    authed(url: string, opts: AuthedHttpOpts): Promise<AuthedHttpResponse>;
  };

  /**
   * The project's **workspace index** — status of the static scan and the
   * AI tiers, plus a bounded "make it fresh" ensure. Requires `index.read`
   * for {@link GezelSDK.index.status | status} and `index.refresh` for
   * {@link GezelSDK.index.ensureFresh | ensureFresh}.
   */
  index: {
    /** Current index status (static state + enrichment/review coverage). */
    status(): Promise<WorkspaceIndexStatus>;
    /**
     * Make the index as fresh as it can get within an awake-time budget:
     * awaited static re-scan, then an AI-tier catch-up drive raced against
     * the budget. Always resolves with an honest readiness report — on a
     * crew with no Boekwachter the AI tiers are reported unachievable
     * rather than awaited, and an expired budget leaves the drive running
     * in the background.
     *
     * @param opts.waitBudgetMs - Awake-time wait budget (default 180s,
     *   capped at 240s to stay inside the script run timeout).
     * @param opts.reviews - Also wait for the per-file AI review tier
     *   (default true).
     */
    ensureFresh(opts?: { waitBudgetMs?: number; reviews?: boolean }): Promise<IndexReadinessReport>;
  };

  /**
   * **Nested scripts** — run another script in the same project and get
   * its stamped output back. No capability is required to call, but the
   * nested script runs under its own `meta.requires`. Nesting is limited
   * to 4 levels deep.
   */
  script: {
    /**
     * Run another script by name and await its result.
     * @typeParam TOutput - Expected shape of the nested script's output.
     * @param name - The script's name (not a path), e.g. `'diff-scan'`.
     * @param input - Input object passed to the nested script.
     * @returns A {@link ScriptResult} carrying status, output, or error.
     *
     * @example
     * ```ts
     * const res = await gezel.script.run<{ issues: string[] }>('diff-scan');
     * if (res.status === 'ok') {
     *   for (const issue of res.output!.issues) gezel.log(issue);
     * }
     * ```
     */
    run<TOutput = unknown>(
      name: string,
      input?: Record<string, unknown>,
    ): Promise<ScriptResult<TOutput>>;
  };
}

export const gezel: GezelSDK = {
  get input() {
    return (rpc.init.input ?? {}) as Record<string, unknown>;
  },
  output(value: unknown): void {
    if (outputStamped) {
      throw new Error('gezel.output() called more than once — a script may only stamp one output');
    }
    outputStamped = true;
    rpc.notify('script.output', { value });
  },
  log(...args: unknown[]): void {
    rpc.notify('script.log', { args });
    process.stderr.write(
      `${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`,
    );
  },
  fs: {
    read: (path) => rpc.call<string>('fs.read', { path }),
    write: (path, content) => rpc.call<void>('fs.write', { path, content }),
    list: (path) => rpc.call<FsEntry[]>('fs.list', { path }),
    listAll: () => rpc.call<string[]>('fs.listAll'),
    stat: (path) => rpc.call<FsStat>('fs.stat', { path }),
    rm: (path) => rpc.call<void>('fs.rm', { path }),
    mkdir: (path) => rpc.call<void>('fs.mkdir', { path }),
    rename: (from, to) => rpc.call<void>('fs.rename', { from, to }),
  },
  artifacts: {
    read: (path) => rpc.call<string>('artifact.read', { path }),
    write: (path, content) => rpc.call<void>('artifact.write', { path, content }),
    list: (prefix, opts) =>
      rpc.call<ArtifactEntry[]>('artifact.list', {
        prefix,
        ...(opts?.recursive ? { recursive: true } : {}),
      }),
    delete: (path) => rpc.call<void>('artifact.delete', { path }),
  },
  documents: {
    read: (name) => rpc.call<string>('document.read', { name }),
    write: (name, content) => rpc.call<void>('document.write', { name, content }),
    list: () => rpc.call<DocumentEntry[]>('document.list'),
    delete: (name) => rpc.call<void>('document.delete', { name }),
  },
  task: {
    get: (ref) => rpc.call('task.get', { ref }),
    steps: (ref) => rpc.call<TaskStep[]>('task.steps', { ref }),
    currentStep: (ref) => rpc.call<TaskStep | null>('task.currentStep', { ref }),
    update: (ref, patch) => rpc.call('task.update', { ref, patch }),
    advance: (ref, nextPhaseName) => rpc.call('task.advance', { ref, nextPhaseName }),
    writeNotes: (ref, content, phaseId) =>
      rpc.call<void>('task.writeNotes', { ref, content, phaseId }),
    appendNote: (ref, text, stepId) => rpc.call<TaskNote>('task.appendNote', { ref, text, stepId }),
    readNotes: (ref, phaseId) => rpc.call<string>('task.readNotes', { ref, phaseId }),
    deleteNote: (ref, noteId) => rpc.call<TaskNote | null>('task.deleteNote', { ref, noteId }),
    create: (req) => rpc.call('task.create', { req }),
  },
  memory: {
    search: (query) => rpc.call<unknown[]>('memory.search', { query }),
    save: (text, meta) => rpc.call<void>('memory.save', { text, meta }),
  },
  llm: {
    oneShot: (prompt, opts) => rpc.call<string>('llm.oneShot', { prompt, opts }),
  },
  mcp: {
    call: (tool, args) => rpc.call('mcp.call', { tool, args }),
  },
  index: {
    status: () => rpc.call<WorkspaceIndexStatus>('index.status'),
    ensureFresh: (opts) =>
      rpc.call<IndexReadinessReport>('index.ensureFresh', {
        ...(opts?.waitBudgetMs !== undefined ? { waitBudgetMs: opts.waitBudgetMs } : {}),
        ...(opts?.reviews !== undefined ? { reviews: opts.reviews } : {}),
      }),
  },
  http: {
    request: (url, opts) =>
      rpc.call<HttpResponse>('http.request', {
        url,
        ...(opts?.method ? { method: opts.method } : {}),
        ...(opts?.body !== undefined ? { body: opts.body } : {}),
        ...(opts?.headers ? { headers: opts.headers } : {}),
      }),
    authed: (url, opts) =>
      rpc.call<AuthedHttpResponse>('http.authed', {
        url,
        credential: opts.credential,
        ...(opts.method ? { method: opts.method } : {}),
        ...(opts.body !== undefined ? { body: opts.body } : {}),
        ...(opts.headers ? { headers: opts.headers } : {}),
        ...(opts.authScheme ? { authScheme: opts.authScheme } : {}),
      }),
  },
  script: {
    run: <TOutput = unknown>(name: string, input?: Record<string, unknown>) =>
      rpc.call<ScriptResult<TOutput>>('script.run', { name, input }),
  },
};

/**
 * Helper for narrowing `gezel.input` to the exact type derived from a
 * `defineScript` meta. Pure type-level alias — nothing to call at
 * runtime. Scripts that want full input typing can do:
 *
 *   const input = gezel.input as InferredInput<typeof meta>;
 */
export type InferredInput<M> = M extends ScriptMeta<infer I, infer _O> ? InferInput<I> : never;
export type InferredOutput<M> = M extends ScriptMeta<infer _I, infer O> ? InferOutput<O> : never;
