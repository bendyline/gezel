import { z } from 'zod';

/**
 * Scripts are sandboxed TypeScript files under
 * `~/.gezel/projects/{projectId}/scripts/{name}.ts` that compose gezel's
 * MCP tools, LLM, and storage primitives into repeatable, inspectable
 * automations. See `docs/scripts.md` / the design doc for rationale.
 *
 * These schemas are the wire contract between the UI, service, and the
 * vendored `@bendyline/gezel-sdk` inside the sandbox. Everything here is
 * data — runtime behavior (dispatcher, permissions, step-hook wiring)
 * lives in `packages/service/src/scripts/`.
 */

/**
 * Named capability tags. Scripts declare these in `meta.requires` to
 * gate which SDK method families they can call. Enforced at dispatcher
 * time — a script that does not declare `'llm'` cannot call
 * `gezel.llm.oneShot`. Lifecycle primitives (`input`, `output`, `log`)
 * are always allowed.
 *
 * The credential-form capability `credential:<name>` is validated
 * separately via `CredentialCapabilitySchema` and combined below into
 * the overall `ScriptCapabilitySchema` union.
 */
export const NamedScriptCapabilitySchema = z.enum([
  'llm',
  'network',
  'workspace.read',
  'workspace.write',
  'artifacts.read',
  'artifacts.write',
  'documents.read',
  'documents.write',
  'tasks.read',
  'tasks.write',
  'memory.read',
  'memory.write',
]);
export type NamedScriptCapability = z.infer<typeof NamedScriptCapabilitySchema>;

/**
 * Parameterized capability for named credentials. A script that needs
 * to do authed work declares e.g. `credential:github.token`. The name
 * is a dotted identifier that resolves via the service-side
 * credential registry. Values must be alphanumeric plus `._-:`. Colons are accepted
 * because connector binding ids use `<type>:<suffix>` as their stable key.
 */
export const CredentialCapabilitySchema = z
  .string()
  .regex(
    /^credential:[a-zA-Z][\w.:-]*$/,
    'credential capability must be of the form "credential:<name>" where <name> starts with a letter and contains letters, digits, underscore, hyphen, dot, or colon',
  );

export const ScriptCapabilitySchema = z.union([
  NamedScriptCapabilitySchema,
  CredentialCapabilitySchema,
]);
export type ScriptCapability = z.infer<typeof ScriptCapabilitySchema>;

/** Helper: a capability string is a credential form iff it starts with `credential:`. */
export function isCredentialCapability(cap: string): cap is `credential:${string}` {
  return cap.startsWith('credential:');
}

/** Pull the credential name out of a `credential:<name>` capability. */
export function credentialCapabilityName(cap: string): string | null {
  if (!isCredentialCapability(cap)) return null;
  return cap.slice('credential:'.length);
}

/* ──────────────────────────── Input descriptors ─────────────────────────── */

export const ScriptStringInputSchema = z.object({
  type: z.literal('string'),
  description: z.string(),
  required: z.boolean().optional(),
  default: z.string().optional(),
  pattern: z.string().optional(),
  multiline: z.boolean().optional(),
});

export const ScriptNumberInputSchema = z.object({
  type: z.literal('number'),
  description: z.string(),
  required: z.boolean().optional(),
  default: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  integer: z.boolean().optional(),
});

export const ScriptBooleanInputSchema = z.object({
  type: z.literal('boolean'),
  description: z.string(),
  required: z.boolean().optional(),
  default: z.boolean().optional(),
});

export const ScriptChoiceInputSchema = z.object({
  type: z.literal('choice'),
  description: z.string(),
  required: z.boolean().optional(),
  default: z.string().optional(),
  options: z
    .array(
      z.object({
        value: z.string(),
        label: z.string().optional(),
      }),
    )
    .min(1),
});

export const ScriptRefInputSchema = z.object({
  type: z.literal('ref'),
  description: z.string(),
  required: z.boolean().optional(),
  kind: z.enum(['gezel', 'task', 'artifact', 'document']),
});

export const ScriptJsonInputSchema = z.object({
  type: z.literal('json'),
  description: z.string(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  schema: z.unknown().optional(),
});

export const ScriptInputFieldSchema = z.discriminatedUnion('type', [
  ScriptStringInputSchema,
  ScriptNumberInputSchema,
  ScriptBooleanInputSchema,
  ScriptChoiceInputSchema,
  ScriptRefInputSchema,
  ScriptJsonInputSchema,
]);
export type ScriptInputField = z.infer<typeof ScriptInputFieldSchema>;

export const ScriptInputsSchema = z.record(z.string(), ScriptInputFieldSchema);
export type ScriptInputs = z.infer<typeof ScriptInputsSchema>;

/* ─────────────────────────── Output descriptors ─────────────────────────── */

export const ScriptStringOutputSchema = z.object({
  type: z.literal('string'),
  description: z.string(),
  nullable: z.boolean().optional(),
});

export const ScriptNumberOutputSchema = z.object({
  type: z.literal('number'),
  description: z.string(),
  nullable: z.boolean().optional(),
});

export const ScriptBooleanOutputSchema = z.object({
  type: z.literal('boolean'),
  description: z.string(),
  nullable: z.boolean().optional(),
});

export const ScriptArrayOutputSchema = z.object({
  type: z.literal('array'),
  description: z.string(),
  itemType: z.enum(['string', 'number', 'boolean', 'object']),
});

export const ScriptObjectOutputSchema = z.object({
  type: z.literal('object'),
  description: z.string(),
  schema: z.unknown().optional(),
});

export const ScriptJsonOutputSchema = z.object({
  type: z.literal('json'),
  description: z.string(),
  schema: z.unknown().optional(),
});

export const ScriptOutputFieldSchema = z.discriminatedUnion('type', [
  ScriptStringOutputSchema,
  ScriptNumberOutputSchema,
  ScriptBooleanOutputSchema,
  ScriptArrayOutputSchema,
  ScriptObjectOutputSchema,
  ScriptJsonOutputSchema,
]);
export type ScriptOutputField = z.infer<typeof ScriptOutputFieldSchema>;

export const ScriptOutputsSchema = z.record(z.string(), ScriptOutputFieldSchema);
export type ScriptOutputs = z.infer<typeof ScriptOutputsSchema>;

/* ───────────────────────────── Script meta ──────────────────────────────── */

export const ScriptMetaSchema = z.object({
  name: z
    .string()
    .regex(
      /^[a-zA-Z][\w-]*$/,
      'name must start with a letter and contain only letters, digits, underscore, or hyphen',
    ),
  description: z.string().min(10),
  /**
   * What the script is for. `gate` = returns a structured GateResult
   * (`{ decision, message, ... }`) and is meant to be attached to a
   * step's gate. Advisory — pickers filter on it; the runtime validates
   * gate outputs against the result schema regardless. Absent = 'action'.
   */
  kind: z.enum(['action', 'gate']).optional(),
  inputs: ScriptInputsSchema.optional(),
  outputs: ScriptOutputsSchema.optional(),
  requires: z.array(ScriptCapabilitySchema).optional(),
});
export type ScriptMeta = z.infer<typeof ScriptMetaSchema>;

/**
 * Where a referenced script resolves from:
 *  - `project`   — `~/.gezel/projects/{id}/scripts/` (default; editable)
 *  - `craftbook` — embedded in the step's source craftbook; installed
 *                  into the project at task creation (provenance-marked)
 *  - `user`      — the user's machine-wide library, `~/.gezel/scripts/`
 *  - `standard`  — the read-only library packed into the app. Trusted:
 *                  standard scripts run even when the security policy
 *                  disables user script execution.
 * Resolution is by EXPLICIT scope only — there is no fallback chain, so
 * a project script can never accidentally shadow a standard one.
 */
export const ScriptScopeSchema = z.enum(['project', 'craftbook', 'user', 'standard']);
export type ScriptScope = z.infer<typeof ScriptScopeSchema>;

/* ──────────────────── Output-driven advance predicate ───────────────────── */

/**
 * Tiny predicate language for step auto-advancement (and craftbook branch
 * routing), evaluated against the script's output object. Intentionally
 * narrow — anything richer than a single field check belongs inside a
 * script.
 */
export const ScriptOutputPredicateSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('always') }),
  z.object({ op: z.literal('never') }),
  z.object({ op: z.literal('ok') }),
  z.object({
    op: z.literal('equals'),
    field: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  }),
  z.object({
    op: z.literal('exists'),
    field: z.string().min(1),
    negate: z.boolean().optional(),
  }),
  z.object({
    op: z.literal('gt'),
    field: z.string().min(1),
    value: z.number(),
  }),
]);
export type ScriptOutputPredicate = z.infer<typeof ScriptOutputPredicateSchema>;

/* ───────────────────────── Step-hook script ref ─────────────────────────── */

/**
 * Reference to a project-scoped script attached to a step via
 * `onEnter` / `onExit`. `autoAdvanceOnSuccess: true` is sugar for
 * `autoAdvanceWhen: { op: 'ok' }`; if both are supplied,
 * `autoAdvanceWhen` wins.
 */
export const ScriptRefSchema = z.object({
  name: z.string().min(1),
  /** Resolution scope; absent = 'project'. See {@link ScriptScopeSchema}. */
  scope: ScriptScopeSchema.optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
  autoAdvanceOnSuccess: z.boolean().optional(),
  autoAdvanceWhen: ScriptOutputPredicateSchema.optional(),
});
export type ScriptRef = z.infer<typeof ScriptRefSchema>;

/**
 * Step events accept a single ref (the historical shape, parsed forever
 * for persisted tasks) or an ordered list. Always handle through
 * {@link normalizeScriptRefs}.
 */
export const ScriptRefListSchema = z.union([ScriptRefSchema, z.array(ScriptRefSchema)]);
export type ScriptRefList = z.infer<typeof ScriptRefListSchema>;

export function normalizeScriptRefs(value: ScriptRefList | undefined): ScriptRef[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/* ────────────────────────────── Run records ─────────────────────────────── */

export const ScriptRunStatusSchema = z.enum(['running', 'ok', 'error']);
export type ScriptRunStatus = z.infer<typeof ScriptRunStatusSchema>;

/**
 * Single SDK call recorded in a ScriptRun's trace. `kind` is the
 * dotted method name (`fs.read`, `llm.oneShot`, `mcp.call:fetch_url`).
 */
export const ScriptRunCallSchema = z.object({
  at: z.string(),
  kind: z.string(),
  argsSummary: z.string(),
  outputSummary: z.string().optional(),
  durationMs: z.number().nonnegative(),
  error: z.string().optional(),
});
export type ScriptRunCall = z.infer<typeof ScriptRunCallSchema>;

export const ScriptRunTriggerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('step'),
    taskRef: z.string(),
    stepId: z.string(),
    moment: z.enum(['enter', 'exit', 'gate']),
  }),
  z.object({
    kind: z.literal('chat'),
    sessionId: z.string(),
    gezelId: z.string(),
  }),
  z.object({
    kind: z.literal('manual'),
    userInitiated: z.literal(true),
  }),
  z.object({
    kind: z.literal('nested'),
    parentRunId: z.string(),
  }),
  z.object({
    kind: z.literal('connector'),
    typeId: z.string(),
    bindingId: z.string(),
  }),
  /**
   * A project-type page invoked one of its declared `pages.tools` through
   * the first-party page-invoke route. User-click-shaped (like `manual`)
   * and therefore ungated by `allowScriptExecution`; the distinct kind
   * exists for auditability and future policy.
   */
  z.object({
    kind: z.literal('page'),
    /** The declared tool name the page invoked (not the script name). */
    tool: z.string(),
  }),
]);
export type ScriptRunTrigger = z.infer<typeof ScriptRunTriggerSchema>;

export const ScriptRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  scriptName: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  status: ScriptRunStatusSchema,
  trigger: ScriptRunTriggerSchema,
  inputs: z.record(z.string(), z.unknown()),
  output: z.unknown().optional(),
  calls: z.array(ScriptRunCallSchema),
  logs: z.string(),
  error: z.string().optional(),
});
export type ScriptRun = z.infer<typeof ScriptRunSchema>;

/* ──────────────────────────── HTTP request/response ─────────────────────── */

export const RunScriptRequestSchema = z.object({
  name: z.string().min(1),
  /** Resolution scope (default 'project') — lets the editor test-run standard/user scripts. */
  scope: ScriptScopeSchema.optional(),
  input: z.record(z.string(), z.unknown()).optional(),
});
export type RunScriptRequest = z.infer<typeof RunScriptRequestSchema>;

export const RunScriptResponseSchema = z.object({
  runId: z.string(),
  status: ScriptRunStatusSchema,
  output: z.unknown().optional(),
  callsSummary: z.array(
    z.object({
      kind: z.string(),
      durationMs: z.number().nonnegative(),
      error: z.string().optional(),
    }),
  ),
  error: z.string().optional(),
});
export type RunScriptResponse = z.infer<typeof RunScriptResponseSchema>;

/**
 * Body for the first-party page-invoke route: a served type page asks the
 * parent bridge to run one of the type's declared `pages.tools`.
 */
export const InvokePageToolRequestSchema = z.object({
  tool: z.string().regex(/^[a-z][a-z0-9_]*$/),
  input: z.record(z.string(), z.unknown()).optional(),
});
export type InvokePageToolRequest = z.infer<typeof InvokePageToolRequestSchema>;

export const InvokePageToolResponseSchema = RunScriptResponseSchema.extend({
  /** Present when the invoked tool declares a reaction. */
  reaction: z
    .object({
      delivered: z.boolean(),
      gezelId: z.string().optional(),
      /** 'engagement-off' | 'project-inactive' | 'no-target' | 'send-failed' */
      reason: z.string().optional(),
    })
    .optional(),
});
export type InvokePageToolResponse = z.infer<typeof InvokePageToolResponseSchema>;

/**
 * Body for the first-party page-read route: a served type page reads a file
 * or directory the type's manifest declares in `pages.reads`. Scope is
 * re-derived from the trusted manifest per request (the write-side analog
 * is `resolvePageTools` on the page-invoke route) — this is the in-bridge
 * replacement for the out-of-band preview-capability fetch, which remains
 * for v0 pages, browser mode, and media URLs.
 */
export const PageReadRequestSchema = z.object({
  op: z.enum(['read', 'list', 'stat']),
  source: z.enum(['workspace', 'artifacts']),
  path: z.string().min(1),
  /** read op only; default derived from extension ('json' for .json else 'text'). */
  as: z.enum(['text', 'json', 'bytes']).optional(),
  /** read op only; capped server-side at PAGE_READ_MAX_BYTES regardless. */
  maxBytes: z.number().int().positive().optional(),
});
export type PageReadRequest = z.infer<typeof PageReadRequestSchema>;

export const PageReadEntrySchema = z.object({
  name: z.string(),
  kind: z.enum(['file', 'dir']),
  size: z.number().nonnegative(),
  mtime: z.number().nonnegative(),
});
export type PageReadEntry = z.infer<typeof PageReadEntrySchema>;

export const PageReadResponseSchema = z.object({
  op: z.enum(['read', 'list', 'stat']),
  /** read: file body (utf8 text or base64 when `encoding: 'base64'`). */
  content: z.string().optional(),
  encoding: z.enum(['utf8', 'base64']).optional(),
  /** list: directory entries (files and dirs, one level). */
  entries: z.array(PageReadEntrySchema).optional(),
  /** read/stat: change token — size:mtime hash; directories hash their listing. */
  etag: z.string(),
  size: z.number().nonnegative().optional(),
  mtime: z.number().nonnegative().optional(),
});
export type PageReadResponse = z.infer<typeof PageReadResponseSchema>;

export const ListScriptsResponseSchema = z.object({
  scripts: z.array(
    z.object({
      name: z.string(),
      meta: ScriptMetaSchema,
      path: z.string(),
    }),
  ),
});
export type ListScriptsResponse = z.infer<typeof ListScriptsResponseSchema>;

/* ─────────────────────── Source editing (script editor) ─────────────────── */

/**
 * File-name shape for scripts. Stricter than `ScriptMetaSchema.name` only
 * in role: this regex is the path-traversal fence — it is validated
 * BEFORE any filesystem path is built from the name.
 */
export const ScriptNameSchema = z
  .string()
  .regex(
    /^[a-zA-Z][\w-]*$/,
    'script name must start with a letter and contain only letters, digits, underscore, or hyphen',
  );

/**
 * One problem surfaced by the save endpoint. `source` distinguishes the
 * three validators: the meta extractor, TypeScript syntax, and the
 * erasable-syntax check (constructs Node's type-stripping rejects at
 * runtime: enums, namespaces with values, parameter properties,
 * `import =`).
 */
export const ScriptDiagnosticSchema = z.object({
  severity: z.enum(['error', 'warning', 'info']),
  source: z.enum(['meta', 'typescript', 'runtime-compat']),
  message: z.string(),
  /** 1-based, when the diagnostic is anchored to a location. */
  line: z.number().optional(),
  column: z.number().optional(),
});
export type ScriptDiagnostic = z.infer<typeof ScriptDiagnosticSchema>;

/**
 * Where an on-disk script came from, derived from its first-line marker:
 * `craftbook` = installed by a craftbook (`// @gezel-craftbook: id@ver`,
 * silently overwritten on upgrade), `import` = generated by import-sync
 * (`// @gezel-import: source#hash`). Hand-authored scripts have none.
 */
export const ScriptProvenanceSchema = z.object({
  kind: z.enum(['craftbook', 'import', 'user', 'standard']),
  /** e.g. "pu/pull-request-review@1.0.0", "skill-x#abc123", "stdlib@1.2.0". */
  ref: z.string(),
});
export type ScriptProvenance = z.infer<typeof ScriptProvenanceSchema>;

/**
 * Raw source read. Unlike the list endpoint (which hides scripts whose
 * meta fails to parse), this always returns the file when it exists —
 * the editor must be able to open broken scripts to fix them. `meta` is
 * present when it parses; `metaError` carries the extractor message
 * otherwise.
 */
export const GetScriptSourceResponseSchema = z.object({
  name: ScriptNameSchema,
  source: z.string(),
  /** sha256 hex of the file bytes; opaque token for conflict detection. */
  hash: z.string(),
  mtimeMs: z.number(),
  meta: ScriptMetaSchema.optional(),
  metaError: z.string().optional(),
  provenance: ScriptProvenanceSchema.optional(),
});
export type GetScriptSourceResponse = z.infer<typeof GetScriptSourceResponseSchema>;

export const SaveScriptSourceRequestSchema = z.object({
  name: ScriptNameSchema,
  source: z.string(),
  /**
   * Hash the editor loaded/saved last. When set and it no longer matches
   * the on-disk file, the save is rejected with `status: 'conflict'`
   * (someone or something else wrote the file). Omit to overwrite
   * unconditionally.
   */
  baseHash: z.string().optional(),
});
export type SaveScriptSourceRequest = z.infer<typeof SaveScriptSourceRequestSchema>;

/**
 * Saves always persist when not conflicted — a broken meta must never
 * cost the user their work — but `metaOk: false` means the script is
 * now invisible to the list endpoint and cannot run until fixed.
 */
export const SaveScriptSourceResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('saved'),
    hash: z.string(),
    metaOk: z.boolean(),
    meta: ScriptMetaSchema.optional(),
    diagnostics: z.array(ScriptDiagnosticSchema),
  }),
  z.object({
    status: z.literal('conflict'),
    currentHash: z.string(),
    currentSource: z.string(),
  }),
]);
export type SaveScriptSourceResponse = z.infer<typeof SaveScriptSourceResponseSchema>;

export const ScriptTemplateIdSchema = z.enum([
  'blank',
  'post-message',
  'fetch-and-summarize',
  'check-files',
  'call-tool',
  'ask-ai',
]);
export type ScriptTemplateId = z.infer<typeof ScriptTemplateIdSchema>;

export const CreateScriptRequestSchema = z.object({
  name: ScriptNameSchema,
  description: z.string().optional(),
  template: ScriptTemplateIdSchema.optional(),
  /**
   * Full source to write instead of a template scaffold. Used by the
   * copy-on-write flow (duplicate a craftbook script minus its
   * provenance marker) and by AI drafting.
   */
  source: z.string().optional(),
});
export type CreateScriptRequest = z.infer<typeof CreateScriptRequestSchema>;

export const CreateScriptResponseSchema = z.object({
  name: ScriptNameSchema,
  source: z.string(),
  hash: z.string(),
});
export type CreateScriptResponse = z.infer<typeof CreateScriptResponseSchema>;

/**
 * The SDK typings served to the editor so Monaco's IntelliSense matches
 * the SDK this daemon vendors into the sandbox. `version` is a content
 * hash — the UI caches by it and the route doubles it as the ETag.
 */
export const SdkTypesResponseSchema = z.object({
  version: z.string(),
  files: z.array(z.object({ name: z.string(), content: z.string() })),
});
export type SdkTypesResponse = z.infer<typeof SdkTypesResponseSchema>;

/** AI-drafted script: "describe what it should do" → full TS source. */
export const DraftScriptRequestSchema = z.object({
  name: ScriptNameSchema,
  description: z.string().min(1),
});
export type DraftScriptRequest = z.infer<typeof DraftScriptRequestSchema>;

export const DraftScriptResponseSchema = z.object({
  source: z.string(),
});
export type DraftScriptResponse = z.infer<typeof DraftScriptResponseSchema>;
