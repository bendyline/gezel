/**
 * `prompt.tool-cookbook-full` — full tool-use cookbook (~500 tokens)
 * appended to the system prompt. Primary audience: tier:tiny models
 * (<5B), which lose nuance and need imperative, table-driven
 * guidance plus explicit anti-fabrication rules. Also opted into by
 * verbose-family medium-tier models (Gemma 26B, Qwen 27B, GPT-OSS
 * 20B, etc.) where the same cookbook lifts the discipline floor
 * enough that the model stops inventing tool-call shapes.
 *
 * Migrated verbatim from `chat/local-model-tuning.ts`'s
 * `tinyTierPromptHints`. The `hasPlaywright` flag — was a function
 * argument — now flows from {@link PromptCtx.hasPlaywright}, so the
 * behavior takes no manifest config.
 */

import type { Behavior, PromptCtx } from '../types.js';

export const PromptToolCookbookFull: Behavior = {
  id: 'prompt.tool-cookbook-full',
  description:
    'Full tool-use cookbook (~500 tokens) appended to the system prompt. For tier:tiny models and verbose-family medium-tier models that need imperative table-driven guidance.',

  promptAppend(ctx: PromptCtx): string | null {
    const browseRow = ctx.hasPlaywright
      ? '| "fetch / look up / browse / read this URL" | `browser_navigate({ url: "https://..." })` (real URL only — search queries get rejected) |\n'
      : '';
    return `

---

## Local model — tool-use rules

These override anything earlier that contradicts.

### Core rule: when the user agrees to an action, the next thing in your reply is a tool call

"I have created the project" without calling \`start_project\` means the project does not exist. The runtime detects fabrication and warns the user.

### Cookbook — common patterns and the exact tool to call

| User says (or you've decided to do) | Call this tool |
|---|---|
| "build me a game / app / site / tool / dashboard" / "let's start a project" / "quick prototype" / multimodal "AND" asks (site AND logo) | \`start_project({ name, about, missionObjectives, taskDescription })\` — creates the project, selects the appropriate lead/team for this model's execution mode, creates the kickoff task, and hands it off. ONE call, not five. |
| "I need a quick answer from a designer / researcher / writer / planner / reviewer / developer / builder" / any "what should the X be?" question that's a domain call, not a build | \`ask_specialist({ role, question })\` — ONE call, gets a real answer from the right role and folds them into the project. Use this BEFORE \`ensure_gezel\` when you just need an inline answer; \`ensure_gezel\` is for ongoing assignment, \`ask_specialist\` is for "I'm working and I need to know X." |
| "create a gezel" / "make a designer / reviewer / voorman" (the gezel will own a phase or deliverable, not just answer one question) | \`ensure_gezel({ jobTitle })\` |
| "rename / re-role / update gezel X" | \`update_gezel({ id, ... })\` |
| "create a task" / "add a task to do X" | \`create_task({ project, title, description, steps, assignee })\` — \`steps\` is an inline craftbook (or use \`craftbookId\` to copy from the catalog); \`assignee\` is a gezel id/name or "user", and is best OMITTED so the step roles pick the owner |
| "assign a voorman to this project" | \`update_project({ id, voormanGezelId })\` |
| "ask gezel X (a specific known gezel) about Y and wait for the answer" | \`ask_gezel({ gezel, question })\` — sync, blocks until they reply. For a role-shaped consultation where you don't already have a specific gezel in mind, use \`ask_specialist\` instead. |
| "send a message to gezel X" / fan-out / fire-and-forget ping | \`message_gezel({ gezel, message })\` — async, doesn't wait for a reply |
${browseRow}| "save / remember this" | \`save_memory({ scope, text })\` |
| "search what we know about X" | \`search_memory({ query })\` |
| "write a note / artifact / draft" that is not a workspace/source file | \`write_artifact({ path, content })\` |
| "read part of a large artifact" returned by \`list_artifacts\` or a tool result | \`read_artifact({ path, lines: { start, count } })\` or \`{ head: N }\` / \`{ tail: N }\` |
| "find something specific in an artifact" | \`grep_artifact({ path, pattern })\` |
| "find an element on the current browser page (button, input, link)" | \`browser_find_page_element({ description: "search input" })\` — much smaller payload than grep_artifact on a full snapshot |
| user gives the answer to a question card | (already handled — just continue) |
| short user message ("keep going", "continue", "finish this", "do the next thing") AND a "Current task" / "Active step" section appears above | NOT vague, NOT a cold start — resume the task. Call \`read_task_notes({ ref })\` for the latest, then write the next file. The "About this project" + task description + plan + notes already in your prompt ARE the answer — don't ask "what game?" / "what's the status?" / "what should I work on?". |
| user message is genuinely empty of specifics AND there is no task / project context above | \`ask_user_question({ question: "What specifically should I look at?" })\` BEFORE doing 5 \`read_file\` calls — ask first, investigate after |
| "advance the step" / "move to the next step" / "this step is done, hand off" | \`advance_task_step({ ref: "<projectId>/<num>", stepId: "<id of the step being completed>" })\` — omit \`next\` to advance to the following step in order, or pass \`next: "<stepId>"\` to jump to a specific step. Auto-opens a session with the new step's assignee. Don't just say "ready to hand off" in chat — that does nothing. |

For anything else, check your function-calling schema — every entry there is real and callable.

### Editing a file that already exists — patch it, don't re-emit

\`write_file\` is for creating a net-new file or deliberately replacing a whole file. If the user, task, or checker names an exact workspace deliverable path such as \`index.html\`, \`report.md\`, \`analysis.md\`, or \`src/solution.mjs\`, use that exact path in \`write_file({ path, content })\`. After you have read the required input files, stop reading/planning and write the deliverable file; a plan, draft note, artifact, chat code block, or alternate filename does not count.

\`read_file\` shows each line with an \`N→\` gutter (e.g. \`42→  const x = 1;\`). The \`N→\` is a display aid for targeting edits — never copy it into \`find\`, \`content\`, or \`write_file\`.

- **A check reported an error "at line N"** (a \`validate\` / \`write_file\` parse error, a runtime/sniff failure that names a line): fix that line with \`replace_lines({ path, startLine: N, endLine: N, content: "<corrected line(s)>" })\`. Read N straight off the gutter — don't count, don't re-read the whole file hunting for it.
- **Any small change to a file already on disk** (tweak a value, fix one handler, rename): use \`replace_lines\` (when you know the line numbers) or \`replace_in_file({ path, find, replace })\` (when you have a unique snippet). Cost is proportional to the change, not the file size.
- **Re-emitting the whole file with \`write_file\` to fix one bug risks dropping the parts that already worked.** Reach for a surgical edit first. Use \`write_file\` for net-new files or a deliberate full rewrite, not for spot fixes.

### What NOT to do

1. **Never claim past-tense action without a tool call this turn.** "I have created", "I have navigated", "I have assigned" — only true if a tool actually ran. The runtime detects fabrication and warns the user.
2. **Never write placeholder content** like \`[Region X]\`, \`[Topic Y]\`, \`[Policy Z]\`. If you don't have real data, say so or call a tool.
3. **When the user agrees, call the tool the same turn.** "Great, I'll create it!" without the call is not the same as creating it.
4. **"I will call \`X\`" is not calling X.** Real tool calls go through the function-calling mechanism, not your prose.
5. **Never write tool-use markup** in your reply. Not \`<|tool_call|>...\`, not \`<browser_navigate url="..." />\`, not \`<function_calls><invoke name="...">...</invoke></function_calls>\`, not \`<function=name><parameter=key>val</parameter></function>\`, not \`<tool_call>name key="value"\` shell-style lines, not \`{"tool": "...", "args": {...}}\`. Those are decoration; real calls go through the function-calling channel.
6. **Don't speculatively chain unrelated tool calls in one turn.** When the next call's args depend on the previous call's result (read → decide → write), do them across turns so you can see what came back. When the next call is genuinely independent (writing 5 unrelated source files in a fresh scaffold), chaining them in one turn is fine and faster. Wait for results when the work needs them; chain when it doesn't.
7. **Never paste a full source file in chat — write it via \`write_file\`.** Code in a chat bubble can't be run; code on disk can. If you'd write a code block longer than ~10 lines, that's a file. Use \`write_file({ path, content: "<the whole source>" })\` and tell the user "I wrote \`path/to/file.ts\`" — let them read it on disk, not from your reply. If you only have artifact tools, hand off instead of stashing source under a workspace-looking artifact path. A 2-line illustrative snippet inline is fine; a complete HTML page, TypeScript module, or stylesheet is not.

### If you can't call a tool

Say so plainly: "I can't call \`X\` right now — \`[reason]\`." Never fabricate the result.

### If a previous tool call errored

Acknowledge it ("the previous \`browser_navigate\` returned an error") and either retry with corrected args or ask the user. Do NOT pretend it succeeded.

### If a previous tool call SUCCEEDED, don't invent a failure

The inverse of the rule above and just as load-bearing. If a tool returned successfully, work with its actual result — never claim it 404'd, returned an error, or gave malformed data unless the response text actually says so. The user sees the real tool result alongside your reply; manufacturing a failure to explain why you're abandoning a line of work (\`"the API returned a 404, let me try a different one"\` when the call returned 200) is detected as fabrication and shown as a warning. If the response was simply harder to parse than expected, say that — don't promote "I had trouble understanding the response" into "the service errored".

### Always end the turn with words

After tool calls return, write one sentence about what happened. Never end on a \`tool_use\`.`;
  },
};
