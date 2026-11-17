import { z } from 'zod';

/**
 * A connector type's contract sidecar: `versions/<v>/test.json` beside its
 * manifest in gilde (or, until a gilde release carries one, a provisional
 * copy in gezel). Each case binds the type with a config, answers every
 * request the type makes from recorded or hand-written exchanges, and states
 * what the corpus must hold afterwards. The catalog contract sweep runs the
 * type's real fetch script or MCP calls against it with no network, so a
 * connector that is "just a JSON file" is tested like code.
 */
export const CONNECTOR_TYPE_TEST_FILENAME = 'test.json';

const HttpExchangeSchema = z.object({
  kind: z.literal('http'),
  request: z.object({
    method: z.string().default('GET'),
    /**
     * Absolute URL. The request matches when origin and path are equal and
     * every query parameter written here has the same value (others may vary).
     */
    url: z.string().url(),
  }),
  response: z.object({
    status: z.number().int().min(100).max(599).default(200),
    headers: z.record(z.string(), z.string()).optional(),
    /** A string is sent as is; anything else as JSON. */
    body: z.unknown().optional(),
  }),
  /** How many requests this answer serves (default 1). */
  times: z.number().int().min(1).max(50).optional(),
});

const McpToolExchangeSchema = z.object({
  kind: z.literal('mcp-tool'),
  tool: z.string().min(1),
  /** Arguments the call must carry (others may be present). */
  args: z.record(z.string(), z.unknown()).optional(),
  /** The tool's result: a string is text content, anything else JSON text. */
  result: z.unknown(),
  isError: z.boolean().optional(),
  times: z.number().int().min(1).max(50).optional(),
});

export const ConnectorTestExchangeSchema = z.discriminatedUnion('kind', [
  HttpExchangeSchema,
  McpToolExchangeSchema,
]);
export type ConnectorTestExchange = z.infer<typeof ConnectorTestExchangeSchema>;

/** One record the corpus must hold, matched by the record's id. */
export const ConnectorTestExpectedRecordSchema = z.object({
  id: z.string().min(1),
  /** Frontmatter values the record must carry (others may be present). */
  frontmatter: z.record(z.string(), z.string()).optional(),
  /** Text the record body must contain. */
  bodyIncludes: z.string().optional(),
});

export const ConnectorTestCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({}),
  /** `none` binds with no stored credential; `placeholder` stores a dummy one. */
  credential: z.enum(['none', 'placeholder']).default('none'),
  /** Sync passes to run before checking (default 1). */
  passes: z.number().int().min(1).max(6).default(1),
  exchanges: z.array(ConnectorTestExchangeSchema).max(60),
  expect: z.object({
    /** The document records, exactly: no record may be missing or extra. */
    records: z.array(ConnectorTestExpectedRecordSchema).optional(),
    /** For an observation type: rows in its tables after the passes. */
    rows: z.number().int().min(0).optional(),
  }),
});
export type ConnectorTestCase = z.infer<typeof ConnectorTestCaseSchema>;

export const ConnectorTypeTestSpecSchema = z.object({
  schemaVersion: z.literal(1),
  provenance: z.object({
    kind: z.enum(['recorded', 'hand-written', 'provider-docs']),
    /** Where the shapes came from: a doc URL, or a note about the recording. */
    source: z.string().optional(),
    recordedAt: z.string().optional(),
  }),
  /** Older versions of the same type the cases also hold for. */
  alsoCovers: z.array(z.string()).optional(),
  cases: z.array(ConnectorTestCaseSchema).min(1).max(12),
});
export type ConnectorTypeTestSpec = z.infer<typeof ConnectorTypeTestSpecSchema>;
