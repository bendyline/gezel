import { z } from 'zod';
import { DeliverableKindSchema } from './craftbook.js';
import { GateCheckSchema } from './gate.js';

/**
 * ─ Craftbook test spec (`test.json`) ─────────────────────────────────
 *
 * Every bundled craftbook ships a per-version eval descriptor as a
 * SIBLING of `craftbook.json`: `versions/<semver>/test.json`. It is the
 * single, consistent contract for "how do we exercise this book" —
 * sample data, API mocks, the driving chat prompt, additional static
 * gates, and an advisory AI-scoring rubric. The eval harness
 * (`evals/src/craftbooks/`) is the primary consumer; catalog CI parses
 * every book's spec so a template can't land without one. The product
 * runtime never reads it — it is inert data outside evals + CI.
 *
 * Design rules (see docs/eval-strategy.md):
 *   - Deterministic checks alone decide pass/fail. The `rubric` is
 *     ALWAYS advisory — scored axes recorded alongside the verdict.
 *   - Checks encode the task CLASS bar ("a real runbook names rollback
 *     steps"), never a specific eval's sniff signals — the same
 *     anti-overtuning rule that governs craftbook step gates.
 *   - A separate sidecar file (not a field in `craftbook.json`) because
 *     `CraftbookDocSchema` rejects unknown keys and the doc is embedded
 *     into running tasks — eval fixtures don't belong in task copies.
 */

/** Current schema version — bump only on a breaking shape change. */
export const CRAFTBOOK_TEST_SCHEMA_VERSION = 1;

/** Filename of the sidecar within a craftbook's version folder. */
export const CRAFTBOOK_TEST_FILENAME = 'test.json';

// ── Eval-only check kinds (promoted from evals/src/craftbooks/types.ts) ─
//
// Their EVALUATORS stay in evals (`gates.ts`) — these schemas exist so a
// test.json can carry them and CI can validate the shape.

export const PrometheusAlertsCheckSchema = z
  .object({
    kind: z.literal('prometheusAlerts'),
    file: z.string().min(1),
    minRules: z.number().int().positive().optional(),
    maxPageAlerts: z.number().int().nonnegative().optional(),
    allowedSeverities: z.array(z.string().min(1)).optional(),
    requiredServices: z.array(z.string().min(1)).optional(),
    requiredRunbookUrls: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type PrometheusAlertsCheck = z.infer<typeof PrometheusAlertsCheckSchema>;

export const NodeScriptPassesCheckSchema = z
  .object({
    kind: z.literal('nodeScriptPasses'),
    script: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
    requiredOutput: z
      .array(
        z
          .object({
            pattern: z.string().min(1),
            flags: z.string().optional(),
            label: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type NodeScriptPassesCheck = z.infer<typeof NodeScriptPassesCheckSchema>;

/**
 * Everything a test.json check slot accepts: the full core gate-check
 * vocabulary (including `judge` for enforcing quality floors) plus the
 * two eval-only executable kinds.
 */
export const CraftbookTestCheckSchema = z.union([
  GateCheckSchema,
  PrometheusAlertsCheckSchema,
  NodeScriptPassesCheckSchema,
]);
export type CraftbookTestCheck = z.infer<typeof CraftbookTestCheckSchema>;

// ── Mock services ────────────────────────────────────────────────────
//
// The declarative request→response data is the SOURCE the live per-trial
// mock server serves (evals/src/mock/). Prompt, mission, and fixture
// content may reference `{{mock:<id>.baseUrl}}` / `{{mock:<id>.credential}}`
// placeholders; the harness substitutes them at trial setup because ports
// are dynamic.

const MockServiceIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'mock service ids are lowercase kebab-case');

export const MockHttpRouteSchema = z
  .object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
    /** Exact path, `:param` segments, or a trailing `*` wildcard. */
    path: z.string().min(1),
    status: z.number().int().min(100).max(599).default(200),
    headers: z.record(z.string(), z.string()).optional(),
    /** String bodies are served verbatim; anything else is JSON-encoded. */
    body: z.unknown(),
    latencyMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type MockHttpRoute = z.infer<typeof MockHttpRouteSchema>;

export const MockServiceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('http'),
      id: MockServiceIdSchema,
      description: z.string().min(1),
      /**
       * v1 mock HTTP is reachable ONLY through the `http.authed`
       * credential rail (anonymous script/browser HTTP hard-rejects
       * loopback), so a credential is required. The harness seeds it and
       * grants the mock's exact origin on the trial project.
       */
      credential: z
        .object({
          name: z
            .string()
            .regex(/^mock\.[a-z0-9][a-z0-9.-]*$/, 'mock credentials are named mock.<service-id>'),
          authScheme: z.enum(['bearer', 'basic']).optional(),
        })
        .strict(),
      routes: z.array(MockHttpRouteSchema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('webhook'),
      id: MockServiceIdSchema,
      description: z.string().min(1),
      /** Receiver path; defaults to `/webhook` when omitted. */
      path: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('cli'),
      id: MockServiceIdSchema,
      description: z.string().min(1),
      /** Fake-CLI shim seeded as a workspace file (today's dry-run pattern). */
      shim: z.object({ path: z.string().min(1), content: z.string() }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('mcp'),
      id: MockServiceIdSchema,
      description: z.string().min(1),
      /** Override the local-catalog id when the mock replaces a real dependency. */
      toolsetId: MockServiceIdSchema.optional(),
      /**
       * Served live by the eval mock rail: each declared tool becomes a
       * real tool on a per-trial Streamable-HTTP MCP endpoint, installed
       * into the trial via a local-catalog `mock-mcp-<id>` toolset.
       * `resultTemplate` is JSON-encoded as the tool result text
       * (default `{"ok":true}` when absent).
       */
      tools: z
        .array(
          z
            .object({
              name: z.string().min(1),
              description: z.string().min(1),
              resultTemplate: z.unknown().optional(),
              /** Deterministic eval-only file materialization after this tool call. */
              writeFixture: z
                .object({
                  surface: z.enum(['workspace', 'artifact']),
                  pathArgument: z.string().min(1),
                  fixture: z.enum(['minimal-pptx']),
                })
                .strict()
                .optional(),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
]);
export type MockService = z.infer<typeof MockServiceSchema>;

// ── Setup / success shapes ───────────────────────────────────────────

export const CraftbookTestFixtureFileSchema = z
  .object({
    path: z.string().min(1),
    content: z.string(),
    /** Defaults to `workspace`. */
    surface: z.enum(['workspace', 'artifact']).optional(),
  })
  .strict();
export type CraftbookTestFixtureFile = z.infer<typeof CraftbookTestFixtureFileSchema>;

export const CraftbookTestWorkerSchema = z
  .object({
    name: z.string().min(1),
    role: z.string().min(1),
    description: z.string().optional(),
    about: z.string().optional(),
  })
  .strict();
export type CraftbookTestWorker = z.infer<typeof CraftbookTestWorkerSchema>;

export const CraftbookTestSetupSchema = z
  .object({
    projectName: z.string().min(1),
    about: z.string().optional(),
    missionObjectives: z.string().optional(),
    files: z.array(CraftbookTestFixtureFileSchema).default([]),
    /**
     * Direct execution target. When present the harness seeds this gezel
     * and sends the kickoff straight to it (measuring whether the book
     * guides the work); absent → the Meester routes.
     */
    worker: CraftbookTestWorkerSchema.optional(),
  })
  .strict();
export type CraftbookTestSetup = z.infer<typeof CraftbookTestSetupSchema>;

export const CraftbookTestDeliverableSchema = z
  .object({
    path: z.string().min(1),
    kind: DeliverableKindSchema,
    minBytes: z.number().int().positive().optional(),
    checks: z.array(CraftbookTestCheckSchema).optional(),
  })
  .strict();
export type CraftbookTestDeliverable = z.infer<typeof CraftbookTestDeliverableSchema>;

export const CraftbookTestMockExpectationSchema = z
  .object({
    /** Mock service id from `mocks[]`. */
    service: MockServiceIdSchema,
    minRequests: z.number().int().positive().optional(),
    /** Regex sources matched against logged request paths. */
    requiredPaths: z.array(z.string().min(1)).optional(),
    forbiddenPaths: z.array(z.string().min(1)).optional(),
    /**
     * Exact MCP tool names that must each have been called at least once
     * on this service (`kind: 'mcp'` only). Exact names, not regexes —
     * the tool roster is fully declared in the same file, so a pattern
     * buys nothing and invites drift. Cross-checked against the mock's
     * declared `tools[]` at parse time.
     */
    requiredTools: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type CraftbookTestMockExpectation = z.infer<typeof CraftbookTestMockExpectationSchema>;

export const CraftbookTestSuccessSchema = z
  .object({
    summary: z.string().min(1),
    deliverables: z.array(CraftbookTestDeliverableSchema).optional(),
    checks: z.array(CraftbookTestCheckSchema).optional(),
    taskNotes: z
      .object({
        minBytes: z.number().int().positive().optional(),
        checks: z.array(CraftbookTestCheckSchema).optional(),
        requireCraftbookTask: z.boolean().optional(),
      })
      .strict()
      .optional(),
    taskGraph: z
      .object({
        checks: z.array(CraftbookTestCheckSchema).optional(),
        requireCraftbookTask: z.boolean().optional(),
        requireDraftRef: z.boolean().optional(),
        draft: z
          .object({
            status: z.enum(['draft', 'paused', 'active', 'complete', 'canceled']).optional(),
            minDescriptionBytes: z.number().int().positive().optional(),
            minOutcomes: z.number().int().positive().optional(),
            minSteps: z.number().int().positive().optional(),
            requireTerminalVerification: z.boolean().optional(),
            requireGatedBuildSteps: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    /** Assertions evaluated against the live mock server's request log. */
    mocks: z.array(CraftbookTestMockExpectationSchema).optional(),
  })
  .strict();
export type CraftbookTestSuccess = z.infer<typeof CraftbookTestSuccessSchema>;

// ── Rubric (advisory, always) ────────────────────────────────────────

export const CraftbookTestRubricSchema = z
  .object({
    artifact: z
      .object({
        /** Workspace or artifact path the judge reads (adapter derives the basename). */
        path: z.string().min(1),
        kind: z.enum(['html', 'markdown', 'yaml', 'typescript', 'json', 'text']),
      })
      .strict(),
    axes: z
      .array(z.object({ name: z.string().min(1), description: z.string().min(1) }).strict())
      .min(1),
    contextNote: z.string().optional(),
  })
  .strict();
export type CraftbookTestRubric = z.infer<typeof CraftbookTestRubricSchema>;

// ── The spec ─────────────────────────────────────────────────────────

export const CraftbookTestSpecSchema = z
  .object({
    schemaVersion: z.literal(CRAFTBOOK_TEST_SCHEMA_VERSION),
    title: z.string().min(1),
    objective: z.string().min(1),
    /**
     * Task-class taxonomy tags (e.g. `html-game`, `corpus`, `external`).
     * The single declared source for harness selection and batch
     * planning — replaces the old regex classifiers.
     */
    tags: z.array(z.string().min(1)).default([]),
    /** Kickoff chat message the harness sends. Required — every book runs. */
    prompt: z.string().min(1),
    setup: CraftbookTestSetupSchema,
    mocks: z.array(MockServiceSchema).default([]),
    success: CraftbookTestSuccessSchema,
    rubric: CraftbookTestRubricSchema,
    qualityFocus: z.array(z.string().min(1)).default([]),
    /**
     * Sanctioned escape hatch for experiments — carried opaquely, never
     * interpreted by CI. Promote a field out of here before relying on it.
     */
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const mockIds = new Set(spec.mocks.map((m) => m.id));
    const mockById = new Map(spec.mocks.map((m) => [m.id, m]));
    for (const [i, expectation] of (spec.success.mocks ?? []).entries()) {
      if (!mockIds.has(expectation.service)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['success', 'mocks', i, 'service'],
          message: `success.mocks[${i}] references unknown mock service "${expectation.service}"`,
        });
      }
      if (expectation.requiredTools && expectation.requiredTools.length > 0) {
        const target = mockById.get(expectation.service);
        if (target && target.kind !== 'mcp') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['success', 'mocks', i, 'requiredTools'],
            message: `success.mocks[${i}].requiredTools requires an mcp service; "${expectation.service}" is kind "${target.kind}"`,
          });
        } else if (target?.kind === 'mcp') {
          const declared = new Set(target.tools.map((tool) => tool.name));
          for (const name of expectation.requiredTools) {
            if (!declared.has(name)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['success', 'mocks', i, 'requiredTools'],
                message: `success.mocks[${i}].requiredTools names undeclared tool "${name}" on mcp service "${expectation.service}"`,
              });
            }
          }
        }
      }
    }
    for (const [i, mock] of spec.mocks.entries()) {
      if (mock.kind === 'http' && mock.credential.name !== `mock.${mock.id}`) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['mocks', i, 'credential', 'name'],
          message: `http mock "${mock.id}" must use credential name "mock.${mock.id}"`,
        });
      }
    }
  });
export type CraftbookTestSpec = z.infer<typeof CraftbookTestSpecSchema>;

// ── Parsing ──────────────────────────────────────────────────────────

export interface ParseCraftbookTestSpecOptions {
  /**
   * `strict` (authoring/CI): unknown keys and future schema versions are
   * errors. `tolerant` (runtime readers): unknown keys are stripped and
   * any `schemaVersion <= CRAFTBOOK_TEST_SCHEMA_VERSION` is accepted, so
   * an older reader survives a spec written by a newer author.
   */
  mode?: 'strict' | 'tolerant';
}

export type ParseCraftbookTestSpecResult =
  | { ok: true; spec: CraftbookTestSpec }
  | { ok: false; errors: string[] };

/**
 * Parse a raw `test.json` payload. Never throws — CI and loaders both
 * want the error list, not an exception.
 */
export function parseCraftbookTestSpec(
  raw: unknown,
  opts?: ParseCraftbookTestSpecOptions,
): ParseCraftbookTestSpecResult {
  const mode = opts?.mode ?? 'strict';
  const candidate = mode === 'tolerant' ? deepStripUnknown(raw) : raw;
  const parsed = CraftbookTestSpecSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, spec: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '<root>';
      return `${path}: ${issue.message}`;
    }),
  };
}

/**
 * Tolerant pre-pass: retry-parse after removing the keys strict mode
 * rejected, and clamp a higher `schemaVersion` down to the current one
 * (minor forward-compat: newer authors may add fields old readers strip).
 * Structural errors still fail — tolerance covers ADDITIVE change only.
 */
function deepStripUnknown(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  // Deep clone — key removal below must never mutate the caller's value.
  const record = structuredClone(raw) as Record<string, unknown>;
  const version = record.schemaVersion;
  if (
    typeof version === 'number' &&
    Number.isInteger(version) &&
    version > CRAFTBOOK_TEST_SCHEMA_VERSION
  ) {
    record.schemaVersion = CRAFTBOOK_TEST_SCHEMA_VERSION;
  }
  for (let pass = 0; pass < 16; pass++) {
    const attempt = CraftbookTestSpecSchema.safeParse(record);
    if (attempt.success) return record;
    const unknownKeyIssues = attempt.error.issues.filter(
      (issue) => issue.code === z.ZodIssueCode.unrecognized_keys,
    );
    if (unknownKeyIssues.length === 0) return record;
    for (const issue of unknownKeyIssues) {
      const target = resolvePath(record, issue.path);
      if (target && typeof target === 'object' && !Array.isArray(target)) {
        for (const key of issue.keys) delete (target as Record<string, unknown>)[key];
      }
    }
  }
  return record;
}

function resolvePath(root: unknown, path: readonly PropertyKey[]): unknown {
  let node: unknown = root;
  for (const segment of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<PropertyKey, unknown>)[segment];
  }
  return node;
}
