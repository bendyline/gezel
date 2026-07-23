import { z } from 'zod';

/**
 * The `gezel` field a plugin author adds to their `package.json`. This is
 * parsed by the service when an environment installs the package.
 *
 * ```json
 * "gezel": {
 *   "name": "hello",
 *   "description": "Greets the user.",
 *   "entry": "./dist/plugin.js",
 *   "tools": [{
 *     "name": "greet",
 *     "description": "Say hello to a name",
 *     "input": { "type": "object", "properties": { "name": {"type":"string"} } }
 *   }]
 * }
 * ```
 *
 * Plugins are plain npm packages. `entry` is a node script that reads a JSON
 * request from stdin and writes a JSON response to stdout. Everything else is
 * metadata — the service uses `tools` to advertise callable tools to the
 * agent runtime.
 */
export const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export const PluginManifestSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  entry: z.string(),
  tools: z.array(ToolDefinitionSchema).default([]),
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/**
 * The wire format a sandboxed plugin receives on stdin. `tool` identifies
 * which tool is being invoked; `input` is the arbitrary payload supplied by
 * the agent.
 */
export const PluginRequestSchema = z.object({
  tool: z.string(),
  input: z.unknown(),
});
export type PluginRequest = z.infer<typeof PluginRequestSchema>;

export const PluginResponseSchema = z.object({
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.string().optional(),
});
export type PluginResponse = z.infer<typeof PluginResponseSchema>;

/**
 * Read and parse a JSON request from stdin. Plugins call this first thing.
 */
export async function readRequest(): Promise<PluginRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return { tool: '', input: null };
  return PluginRequestSchema.parse(JSON.parse(raw));
}

export function writeResponse(response: PluginResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

export function ok(output?: unknown): PluginResponse {
  return { ok: true, output };
}

export function fail(error: string): PluginResponse {
  return { ok: false, error };
}

/**
 * Structured log line — the service scrapes stderr for these and routes them
 * into the task log stream.
 */
export function log(
  level: 'info' | 'warn' | 'error',
  message: string,
  extra?: Record<string, unknown>,
): void {
  process.stderr.write(`${JSON.stringify({ lv: true, level, message, ...extra })}\n`);
}
