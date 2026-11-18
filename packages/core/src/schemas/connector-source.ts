import { z } from 'zod';

/**
 * Strict shapes of a connector type's `source` block, one per driver. The
 * runtime manifest keeps `source` an open record so content can run ahead of
 * the app (see "Gezel and gilde are not in schema lockstep"); these are what
 * the catalog contract sweep and authoring check a version against, so a
 * misspelled path or a field the driver never reads fails in CI instead of
 * syncing nothing.
 */

const JsonPath = z.string().regex(/^\$(\.[^.\s]+)*$/, 'a `$.a.b` path');

export const McpConnectorSourceSchema = z
  .object({
    server: z.union([
      z
        .object({
          command: z.string().min(1),
          args: z.array(z.string()).optional(),
          envFromSecret: z.record(z.string(), z.string()).optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('http'),
          transport: z.enum(['streamable-http', 'sse']).optional(),
          url: z.string().url(),
          headersFromSecret: z.record(z.string(), z.string()).optional(),
        })
        .strict(),
    ]),
    list: z
      .object({
        tool: z.string().min(1),
        args: z.record(z.string(), z.unknown()).optional(),
        cursorArg: z.string().optional(),
        cursorFrom: JsonPath.optional(),
        itemsPath: JsonPath,
        idPath: JsonPath.optional(),
        tsPath: JsonPath.optional(),
      })
      .strict(),
    fetch: z
      .object({ tool: z.string().min(1), idArg: z.string().min(1) })
      .strict()
      .optional(),
    actions: z.record(z.string(), z.object({ tool: z.string().min(1) }).strict()).optional(),
  })
  .strict();

export const ScriptConnectorSourceSchema = z
  .object({
    fetch: z.string().optional(),
    inlineFetch: z.string().min(1).optional(),
    scope: z.enum(['user', 'project', 'craftbook', 'standard']).optional(),
    idPath: JsonPath.optional(),
    tsPath: JsonPath.optional(),
    table: z.string().optional(),
    tablePath: JsonPath.optional(),
    rowMap: z.record(z.string(), z.string()).optional(),
    partition: z.string().optional(),
  })
  .strict()
  .refine(
    (s) => Boolean(s.fetch || s.inlineFetch),
    'a script source names `fetch` or `inlineFetch`',
  );

export const SpectralConnectorSourceSchema = z
  .object({
    component: z.string().min(1),
    action: z.string().min(1),
    connectionKey: z.string().min(1),
    connectionInput: z.string().min(1),
    inputs: z.record(z.string(), z.unknown()).optional(),
    itemsPath: JsonPath,
    tsPath: JsonPath.optional(),
    cursor: z
      .object({ argInput: z.string().optional(), fromPath: JsonPath.optional() })
      .strict()
      .optional(),
  })
  .strict();

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'a lowercase hex SHA-256');

/**
 * The published component a Spectral type runs, pinned exactly. Downloaded
 * when a connection is made, checked against both hashes, and run by the
 * runner's own copy of the SDK (`spectral` must admit it).
 */
export const SpectralComponentPinSchema = z
  .object({
    name: z
      .string()
      .regex(
        /^@prismatic-io\/components-[a-z0-9][a-z0-9-]*$/,
        'a published `@prismatic-io/components-*` package',
      ),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'an exact version'),
    /** SHA-256 of the registry tarball. */
    sha256: Sha256,
    /** The callable entry inside the package, e.g. `npm-dist/index.cjs`. */
    entry: z
      .string()
      .min(1)
      .refine(
        (p) => !p.startsWith('/') && !p.split('/').includes('..'),
        'a path inside the package',
      ),
    entrySha256: Sha256,
    /** The component's peer range for `@prismatic-io/spectral`, as published. */
    spectral: z.string().min(1),
    license: z.enum(['Apache-2.0', 'MIT']),
    /** When the version was published; authoring refuses one under 7 days old. */
    publishedAt: z.string().datetime(),
  })
  .strict();

/**
 * A Spectral type built on a published component. `trigger` mode drains a
 * polling trigger and keeps its position as the cursor (a `window` type);
 * `action` mode pages an action to the end every pass (a full listing).
 */
export const SpectralComponentSourceSchema = z
  .object({
    package: SpectralComponentPinSchema,
    mode: z.enum(['trigger', 'action']),
    trigger: z.string().min(1).optional(),
    action: z.string().min(1).optional(),
    /** Which of the component's connections the credential fills, and the input that takes it. */
    connection: z.object({ key: z.string().min(1), input: z.string().min(1) }).strict(),
    /** Literal values, or `$config.<key>` from the binding's settings. */
    inputs: z.record(z.string(), z.unknown()).optional(),
    items: z.union([
      z.object({ resolver: z.literal(true) }).strict(),
      z.object({ paths: z.array(JsonPath).min(1) }).strict(),
    ]),
    idPath: JsonPath.optional(),
    tsPath: JsonPath.optional(),
    /** `action` mode: the input that takes a page token, and where the next one is. */
    page: z
      .object({ input: z.string().min(1), from: JsonPath })
      .strict()
      .optional(),
    /** Every origin the component may reach; the runner refuses the rest. */
    origins: z
      .array(z.string().regex(/^https:\/\/(\*\.)?[a-z0-9.-]+(:\d+)?$/, 'an https origin'))
      .min(1),
    limits: z
      .object({
        maxPages: z.number().int().min(1).max(10_000).optional(),
        maxItems: z.number().int().min(1).max(100_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.mode === 'trigger' && !s.trigger) {
      ctx.addIssue({ code: 'custom', path: ['trigger'], message: 'trigger mode names a trigger' });
    }
    if (s.mode === 'action' && !s.action) {
      ctx.addIssue({ code: 'custom', path: ['action'], message: 'action mode names an action' });
    }
    if (s.mode === 'trigger' && s.page) {
      ctx.addIssue({ code: 'custom', path: ['page'], message: 'a trigger pages itself' });
    }
  });

export type SpectralComponentPin = z.infer<typeof SpectralComponentPinSchema>;
export type SpectralComponentSource = z.infer<typeof SpectralComponentSourceSchema>;

/** A Spectral source that runs a published component (rather than a vendored slice). */
export function isSpectralComponentSource(source: unknown): boolean {
  return Boolean(source && typeof source === 'object' && 'package' in source);
}

export const NativeConnectorSourceSchema = z.object({ adapterId: z.string().min(1) }).strict();

/** A device type also names the hardware family its live adapter drives. */
export const DeviceConnectorSourceSchema = z
  .object({ adapterId: z.string().min(1), family: z.string().min(1).optional() })
  .strict();

/** Problems with a `source` block for its driver; empty when it is well formed. */
export function connectorSourceProblems(driver: string, source: unknown): string[] {
  const schema =
    driver === 'mcp'
      ? McpConnectorSourceSchema
      : driver === 'script'
        ? ScriptConnectorSourceSchema
        : driver === 'spectral'
          ? isSpectralComponentSource(source)
            ? SpectralComponentSourceSchema
            : SpectralConnectorSourceSchema
          : driver === 'native'
            ? NativeConnectorSourceSchema
            : driver === 'device'
              ? DeviceConnectorSourceSchema
              : null;
  if (!schema) return [`unknown driver '${driver}'`];
  const parsed = schema.safeParse(source);
  return parsed.success
    ? []
    : parsed.error.issues.map((i) => `${i.path.join('.') || 'source'}: ${i.message}`);
}
