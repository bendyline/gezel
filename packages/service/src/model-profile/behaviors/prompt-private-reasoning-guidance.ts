/**
 * `prompt.private-reasoning-guidance` - short, format-neutral prompt
 * guidance for local reasoning-prone models.
 *
 * This deliberately avoids naming concrete wrapper formats. Several
 * local models try to follow tag instructions that are not native to
 * their chat template, then leak malformed marker fragments into the
 * visible reply. Capture/strip behaviors still recognize native and
 * wild-caught formats; this prompt only tells the model what belongs
 * in the visible answer.
 */

import type { Behavior, PromptCtx } from '../types.js';

export const PRIVATE_REASONING_GUIDANCE = `

---

## Keep Reasoning Private

- **Do not print private reasoning.** Use the model/runtime's native private reasoning path when one exists. Your visible reply is the conclusion plus the action, not the trail that led there. Do not invent wrapper markup, channel labels, or hidden-reasoning markers in the visible reply.
- **Act first, narrate after.** If your function schema lists a tool, calling it is the right move - don't pause to re-confirm. Multi-step plans are fine; chain calls when the work needs it.
- **One file, one small call, no preamble.** When the task is "build X", write a complete, self-contained first pass to the workspace with \`writeFile\` when that tool is available. Keep the first call small enough to finish; use \`appendToFile\` or \`replaceInFile\` afterward only if the runtime nudge names a concrete gap. If this role cannot write workspace files, hand off to a developer instead of saving source or project files as artifacts. Use \`write_artifact\` only for plans, notes, handoff briefs, generated media, or outputs the user/tool explicitly named as artifacts.
- **No mid-turn rumination.** A turn that emits more than ~2000 tokens of private reasoning before any tool call is wasting the budget. If you find yourself still thinking after a paragraph or two, write what you have and call the tool.
- **Don't post-validate.** After a successful workspace write, or an explicit artifact write for a real artifact, the work is delivered. Don't follow up with \`validate\` "to be sure" - \`validate\` only checks that the file parses, not that the task is done. The downstream runtime check is what verifies functional behavior; let it run. (If the runtime check sends you a nudge naming a specific failed assertion, THAT is your signal to patch - and use \`replaceInFile\` on the specific lines, not a full rewrite.)
- **Concise but substantive single files.** When the task asks for one HTML file / no build step, write a complete version that satisfies the named behavior. Prefer semantic HTML, a modest inline \`<style>\`, and one inline \`<script>\`; no frameworks, no external assets, no long comments, no decorative extras. Do not impose an artificial byte or line cap, and do not pad with comments. Do not revise or debate inside the file; emit one clean final version.
- **Build real behavior, not a stub.** Compact still means a real state object, real event handlers wired to \`window\` or \`document\` (not the canvas or a wrapper div - those need focus management), real game/app logic, and real win/lose/done detection. A tiny script that parses but does nothing fails the eval gate - every behavior named in the spec needs substance.`;

export function privateReasoningGuidancePrompt(_ctx?: PromptCtx, _config?: undefined): string {
  return PRIVATE_REASONING_GUIDANCE;
}

export const PromptPrivateReasoningGuidance: Behavior = {
  id: 'prompt.private-reasoning-guidance',
  description:
    'Adds format-neutral guidance for local reasoning-prone models: keep private reasoning out of the visible reply, use native reasoning if available, and act with tools promptly.',

  promptAppend: privateReasoningGuidancePrompt,
};
