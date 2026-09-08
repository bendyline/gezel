import type { McpBridgePool } from '../mcp-bridge-pool.js';

export interface ChatCompletionTool {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

// Minimal `append_to_file` surfaced ONLY during a write-continuation. The
// base immediate-write surface is write_file-only; on truncation we add
// this so the model can emit the file's missing tail instead of
// re-writing the whole thing (which would just truncate again).
// Constructed inline so it doesn't depend on the role-filtered bridge
// surface, which deliberately hides append_to_file from builders.
export const APPEND_TO_FILE_CONTINUATION_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'append_to_file',
    description:
      'Append text to the END of an existing workspace file. Use this to write the remaining tail of a file whose previous write_file was truncated mid-content. Do not repeat content already on disk — start exactly where the file currently ends.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path of the file to append to.' },
        content: {
          type: 'string',
          description: 'Text appended verbatim at the current end of the file.',
        },
      },
      required: ['path', 'content'],
    },
  },
};

export function chatCompletionToolName(tool: ChatCompletionTool): string | undefined {
  return tool.function.name;
}

/**
 * Required top-level properties absent from one parsed tool call.
 *
 * This deliberately checks presence only. A present-but-wrongly-typed value
 * remains the MCP validator's job; the MLX Hermes grammar promises only that
 * every declared required key is emitted before the call can close. Seeing a
 * missing key is therefore evidence that the live constrained-decoding path
 * broke its own contract, not an ordinary model validation miss.
 */
export function missingTopLevelRequiredToolArgs(
  schema: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
): string[] {
  const required = schema?.required;
  if (!Array.isArray(required)) return [];
  const missing: string[] = [];
  for (const key of required) {
    if (
      typeof key === 'string' &&
      !missing.includes(key) &&
      !Object.prototype.hasOwnProperty.call(args, key)
    ) {
      missing.push(key);
    }
  }
  return missing;
}

export function hermesRequiredArgGrammarRequested(body: Record<string, unknown>): boolean {
  const hint = body.tool_grammar;
  if (!hint || typeof hint !== 'object' || Array.isArray(hint)) return false;
  const record = hint as Record<string, unknown>;
  return (
    record.format === 'hermes' && (record.mode === undefined || record.mode === 'name-and-params')
  );
}

export function validatorReportedMissingRequiredArgs(output: string): boolean {
  return /rejected by validator[\s\S]*missing required fields?:/i.test(output);
}

/** OpenAI-compatible streaming tool-call accumulator used by the MLX provider. */
export class MlxToolCallAccumulator {
  private readonly byIndex = new Map<number, { id: string; name: string; arguments: string }>();

  size(): number {
    return this.byIndex.size;
  }

  ingest(delta: ToolCallDelta): void {
    const idx = delta.index;
    let entry = this.byIndex.get(idx);
    if (!entry) {
      entry = { id: '', name: '', arguments: '' };
      this.byIndex.set(idx, entry);
    }
    if (delta.id) entry.id = delta.id;
    if (delta.function?.name) entry.name = delta.function.name;
    if (delta.function?.arguments) entry.arguments += delta.function.arguments;
  }

  finalize(): Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }> {
    return Array.from(this.byIndex.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({
        id: v.id,
        type: 'function' as const,
        function: { name: v.name, arguments: v.arguments },
      }));
  }
}

export function toChatCompletionsTools(bridges: McpBridgePool): ChatCompletionTool[] {
  return bridges.getOpenAITools().map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}
