/**
 * Is a whole textual tool call already present in streamed output?
 *
 * Read where a turn can act on exactly ONE call
 * (`SessionOpts.singleToolCallTurn`): once that call is complete nothing
 * else the model writes can be used, so the provider stops the stream.
 * Wild-caught (qwen3.8-27b MLX Meester, 2026-09-23): after its
 * `invoke_craftbook` call the model wrote the call again, then
 * `</function>` 1300+ times until max_tokens.
 *
 * The outermost wrapper decides. A Hermes call is not complete at
 * `</function>` while its `<tool_call>` is still open — the salvage pass
 * reads the closed envelope, and stopping between the two closers would
 * hand it a truncated one.
 */
export function hasCompleteToolCallMarkup(text: string): boolean {
  if (text.includes('<tool_call>')) return /<tool_call>[\s\S]*?<\/tool_call>/.test(text);
  if (text.includes('<function_calls>')) {
    return /<function_calls>[\s\S]*?<\/function_calls>/.test(text);
  }
  if (text.includes('<function=')) return /<function=[^>\s]+>[\s\S]*?<\/function>/.test(text);
  return /<invoke\s+name="[^"]+"\s*>[\s\S]*?<\/invoke>/.test(text);
}
