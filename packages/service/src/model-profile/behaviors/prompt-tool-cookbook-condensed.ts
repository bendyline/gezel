/**
 * `prompt.tool-cookbook-condensed` — compact anti-fabrication cookbook
 * appended to the system prompt. Primary audience: tier:small models
 * (5–12B) — Llama 8B, Mistral 7B, Qwen 7B — that pick up cookbook
 * patterns from about.md naturally and just need the past-tense +
 * tool-call-channel reminders.
 *
 * Also reused by verbose-family large-tier models (Qwen 27B+, gpt-oss
 * 20B+, QwQ 32B, DeepSeek-R1 distills). Rule #4 — "`<|tool_call|>`
 * markup is not calling X" — is the load-bearing one for that
 * audience: without it, Qwen 3.6 27B emits visible
 * `<tool_call>...</tool_call>` envelopes in chat instead of issuing a
 * real function call.
 *
 * Migrated verbatim from `chat/local-model-tuning.ts`'s
 * `SMALL_TIER_PROMPT_HINTS`.
 */

import type { Behavior } from '../types.js';

const COOKBOOK_CONDENSED = `

---

## Local model — anti-fabrication rules

1. **Never claim past-tense action without a tool call this turn.** "I have created", "I have navigated" — only true if a tool ran. The runtime detects fabrication.
2. **Never write placeholder content** like \`[Region X]\`, \`[Topic Y]\`. If you don't have real data, say so or call a tool.
3. **When the user agrees, call the tool the same turn.** "I'll create it!" without the call is not the same as creating it.
4. **Markup is not a tool call.** "I will call \`X\`", \`<|tool_call|>\`, \`<browser_navigate url="..." />\`, \`<function_calls><invoke name="...">...</invoke></function_calls>\`, \`<function=name><parameter=key>val</parameter></function>\`, \`<tool_call>name key="value"\` shell-style lines, or a \`{tool, args}\` JSON blob in your reply — none of these run the tool. Real calls go through the function-calling channel.
5. **If a previous call errored, acknowledge it.** Don't pretend it succeeded.
6. **If a previous call SUCCEEDED, don't invent a failure.** Inverse of #5. The user sees the real tool result; claiming a 200 was a 404, or that a parseable response was "malformed", is detected as fabrication. If you couldn't make sense of the response, say so — don't promote that into a service error.
7. **End every turn with words.** After tool calls return, write one sentence about what happened. Never end on a \`tool_use\`.
8. **Tool result mentions an artifact path?** The full data lives there. Use \`read_artifact({ path, lines: { start, count } })\` slices or \`grep_artifact({ path, pattern })\` to navigate. If the path appears under "Workspace files", it is not an artifact path; use \`read_file\`.
9. **Never paste a full source file in chat — write it via \`write_file\`.** Code in a chat bubble can't be run; code on disk can. >10 lines = a file. If you only have artifact tools, hand off instead of stashing source under a workspace-looking artifact path.
10. **Exact deliverable path means exact \`write_file\` path.** If the task or checker names \`index.html\`, \`report.md\`, \`src/solution.mjs\`, etc., create that exact workspace file. After you read the required inputs, the next concrete action is \`write_file({ path: "<exact path>", content: <full file> })\`, not another plan, draft, artifact, or differently named file.
11. **Fixing an existing file? Patch it, don't re-emit.** \`read_file\` shows \`N→\` line gutters (the \`N→\` is a display aid, not file text — never copy it in). When a check reports an error "at line N", fix that line with \`replace_lines({ path, startLine: N, endLine: N, content })\`; for a unique snippet use \`replace_in_file({ path, find, replace })\`. Re-emitting the whole file with \`write_file\` to fix one bug risks stomping the parts that already worked.`;

export const PromptToolCookbookCondensed: Behavior = {
  id: 'prompt.tool-cookbook-condensed',
  description:
    'Condensed anti-fabrication cookbook appended to the system prompt. For tier:small models and verbose-family large-tier models that need the past-tense + markup-not-tool-call reminders (plus exact write_file path discipline) without the full table.',

  promptAppend(): string {
    return COOKBOOK_CONDENSED;
  },
};
