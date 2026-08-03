/**
 * Guards the tool-call linkage the MLX python sidecar hands to the chat
 * template.
 *
 * The sidecar rebuilds every inbound message before templating it. When
 * that rebuild dropped `tool_calls` / `tool_call_id`, Gemma's template —
 * which renders a `role: "tool"` message only when it can pair it with
 * the assistant call it answers — emitted nothing for the entire
 * exchange. The model never saw a single tool result, re-issued the same
 * call, and died on the repeat-guard. Measured on gemma4-26b-q4: 62% of
 * turns (346/559) re-sent a prompt ~5 tokens longer than the last, and
 * the whole gemma family sat at 5/11 on the core suite regardless of
 * parameter count while qwen ran 8-10/11 on the same server. Qwen hid it
 * for months because Hermes-style templates render a bare tool message.
 *
 * Both halves are load-bearing and fail silently, so both are asserted:
 *   1. `ChatMessageReq` must DECLARE `tool_calls` — pydantic drops
 *      undeclared fields at parse time, before `_build_prompt` runs.
 *   2. `_build_prompt` must PROPAGATE the tool fields onto the dict it
 *      templates.
 *   3. `function.arguments` must reach the template as a MAPPING. The
 *      OpenAI wire format is a JSON string; Qwen's template does
 *      `arguments | items` and raises TypeError on a string, and
 *      `apply_chat_template`'s recovery path responds by re-rendering
 *      with `tools` dropped entirely — so a string here costs the model
 *      its whole tool surface, not just one message.
 *
 * The python sidecar has no pytest harness wired and does not run in CI,
 * so these are source-level guards in the suite that does — the same
 * shape as tests/published/criticalSubpaths.test.ts.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SERVER_SRC = readFileSync(
  fileURLToPath(new URL('./python/gezel_mlx_server.py', import.meta.url)),
  'utf8',
);

function sliceBlock(source: string, header: string): string {
  const start = source.indexOf(header);
  expect(start, `${header} not found in gezel_mlx_server.py`).toBeGreaterThan(-1);
  const rest = source.slice(start + header.length);
  // Next top-level `def`/`class` ends the block.
  const end = rest.search(/\n(?:def |class |@)/);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('MLX sidecar tool-call linkage', () => {
  it('declares tool_calls on the request model so pydantic keeps it', () => {
    const model = sliceBlock(SERVER_SRC, 'class ChatMessageReq(BaseModel):');
    expect(model).toMatch(/\btool_calls\s*:/);
    expect(model).toMatch(/\btool_call_id\s*:/);
  });

  it('propagates tool_calls and tool_call_id through _build_prompt', () => {
    const build = sliceBlock(SERVER_SRC, 'def _build_prompt(');
    expect(build).toMatch(/\["tool_calls"\]\s*=/);
    expect(build).toMatch(/\["tool_call_id"\]\s*=/);
  });

  it('gates the linkage on a per-template probe rather than sending it always', () => {
    // Always-on is more correct on paper and measurably worse for Hermes
    // templates: Qwen starts seeing its own past `<tool_call>` blocks in the
    // transcript and imitates them. Core-suite MLX went 8/11 -> 5/11, tool
    // calls 457 -> 753, and three fast passes became slow model-stuck retry
    // loops. Only templates that actually LOSE the tool result without the
    // pairing get it; everything else stays on the byte-identical legacy
    // shape (which also keeps their prompt caches valid).
    const build = sliceBlock(SERVER_SRC, 'def _build_prompt(');
    expect(build).toMatch(/if link_tools:/);
    expect(build).toMatch(/_template_needs_tool_linkage\(/);

    const probe = sliceBlock(SERVER_SRC, 'def _template_needs_tool_linkage(');
    // The verdict must come from comparing a linked render against a bare
    // one, not from a hardcoded family list.
    expect(probe).toMatch(/_LINKAGE_PROBE_MARK not in bare/);
    expect(probe).toMatch(/_LINKAGE_PROBE_MARK in linked/);
    // A probe that raises must fall back to the legacy shape, never to
    // "send it anyway" — that would reintroduce the Qwen regression on any
    // template whose probe render happens to fail.
    expect(probe).toMatch(/needs = False/);
    expect(probe).toMatch(/_TOOL_LINKAGE_PROBE\[key\] = needs/);
  });

  it('normalizes stringified function.arguments to a mapping', () => {
    const shaper = sliceBlock(SERVER_SRC, 'def _template_tool_calls(');
    expect(shaper).toMatch(/json\.loads/);
    // Anything that fails to parse must pass through, never raise:
    // apply_chat_template's fallback reacts to exceptions by dropping tools.
    expect(shaper).toMatch(/except \(ValueError, TypeError\)/);
    const build = sliceBlock(SERVER_SRC, 'def _build_prompt(');
    expect(build).toMatch(/_template_tool_calls\(/);
  });
});
