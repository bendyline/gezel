import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/**
 * What an app hears when it calls a Gezel tool without the arguments it
 * needs. Claude Code defers MCP tools, and Sonnet 5.5 often calls one without
 * loading its schema: it sent `search` no query in 7 of 40 runs and gave up on
 * Gezel after the SDK's bare validation error in 5 of them (trial t1), and did
 * the same to `read_doc_as_markdown` (trial t2). The reply names what the tool
 * needs, what each argument means, and an example call.
 */

type JsonSchema = {
  properties?: Record<string, { description?: string }>;
  required?: string[];
};

/** A concrete call for each tool whose arguments a model would otherwise guess. */
const EXAMPLES: Record<string, Record<string, unknown>> = {
  search: { query: 'where uploaded files are checked for size' },
  search_memory: { query: 'how we name release branches' },
  save_memory: { text: 'Releases ship on Tuesdays after the 14:00 check-in.' },
  read_doc_as_markdown: { path: 'docs/report.docx' },
  read_document: { path: 'style-guide.md' },
  describe_image: { path: 'screenshots/error.png' },
  generate_image: {
    prompt: 'A white delivery van on a quiet street at sunrise, flat illustration',
  },
  convert_document: {
    source: { kind: 'markdown', markdown: '# Title\n\nBody text.' },
    targets: ['docx'],
  },
  save_artifact: {
    artifactUri: 'docblocks://artifacts/<id from convert_document>',
    destination: { path: 'report.docx' },
  },
  preview_document: { source: { kind: 'artifact', uri: 'docblocks://artifacts/<id>' } },
  inspect_document: { source: { kind: 'file', path: 'docs/report.docx' } },
};

/** Required arguments `args` leaves out. */
export function missingArguments(schema: JsonSchema, args: unknown): string[] {
  const given = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  return (schema.required ?? []).filter(
    (name) => given[name] === undefined || given[name] === null,
  );
}

function describe(schema: JsonSchema, name: string): string {
  const description = schema.properties?.[name]?.description?.trim();
  return description ? `\`${name}\` (${description.replace(/\.$/, '')})` : `\`${name}\``;
}

function listed(items: string[]): string {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * The reply to a call `schema` rejects. `detail` is the validator's own words,
 * kept when the arguments were there but wrong.
 */
export function argumentHelp(
  tool: string,
  schema: JsonSchema,
  args: unknown,
  detail?: string,
): string {
  const missing = missingArguments(schema, args);
  const example = EXAMPLES[tool];
  const parts =
    missing.length > 0
      ? [`\`${tool}\` needs ${listed(missing.map((name) => describe(schema, name)))}.`]
      : [
          `\`${tool}\` could not use those arguments: ${detail ?? 'they do not match its schema'}.`,
          ...((schema.required ?? []).length > 0
            ? [`It needs ${listed((schema.required ?? []).map((name) => describe(schema, name)))}.`]
            : []),
        ];
  if (example) parts.push(`For example: ${JSON.stringify(example)}`);
  return parts.join(' ');
}

const SDK_PREFIX = /^(MCP error -?\d+: )?Input validation error: Invalid arguments for tool \S+: /;

/**
 * Answer every argument the server's own validation rejects with
 * {@link argumentHelp} instead of the SDK's message. The SDK keeps the
 * validation step private, so this wraps it on the instance; a test pins it.
 */
export function teachInvalidArguments(server: McpServer): void {
  const target = server as unknown as {
    validateToolInput(
      tool: { inputSchema?: unknown },
      args: unknown,
      name: string,
    ): Promise<unknown>;
  };
  const validate = target.validateToolInput.bind(server);
  target.validateToolInput = async (tool, args, name) => {
    try {
      return await validate(tool, args, name);
    } catch (err) {
      if (!(err instanceof McpError) || err.code !== ErrorCode.InvalidParams) throw err;
      let schema: JsonSchema = {};
      try {
        schema = z.toJSONSchema(tool.inputSchema as z.ZodType, { io: 'input' }) as JsonSchema;
      } catch {}
      // A plain Error becomes the tool result's text without an "MCP error" prefix.
      throw new Error(argumentHelp(name, schema, args, err.message.replace(SDK_PREFIX, '')));
    }
  };
}
