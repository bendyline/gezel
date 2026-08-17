import { describe, expect, it } from 'vitest';
import {
  CONSTRAINED_WRITE_MIN_TOKENS,
  type LocalChatCompletionTool,
  applyConstrainedTurnShape,
  isImmediateFileWriteTurn,
  isScenarioFileRepairPrompt,
  readFileOnlyTools,
  writeFileOnlyTools,
} from './constrained-turn.js';

function tool(name: string): LocalChatCompletionTool {
  return { type: 'function', function: { name, description: name, parameters: {} } };
}

const ROSTER = [tool('read_file'), tool('write_file'), tool('message_gezel'), tool('list_dir')];

describe('isImmediateFileWriteTurn', () => {
  it('fires with write_file present even when the roster is still wide', () => {
    // The regression that made MLX's private copy unreachable: it required
    // tools.length === 1, a surface produced only by the narrowing MLX never
    // implemented. Across 30 paired trials of qwen3.8-27b-q4, zero MLX turns
    // entered the branch.
    expect(isImmediateFileWriteTurn('Do not end your turn until `write_file` lands.', ROSTER)).toBe(
      true,
    );
  });

  it('still fires on an already-narrowed surface', () => {
    expect(
      isImmediateFileWriteTurn('Do not end your turn until `write_file` lands.', [
        tool('write_file'),
      ]),
    ).toBe(true);
  });

  it('does not fire without a write_file tool to call', () => {
    expect(
      isImmediateFileWriteTurn('Do not end your turn until `write_file` lands.', [
        tool('read_file'),
      ]),
    ).toBe(false);
  });

  it('stands down on a scenario repair turn so the model can read first', () => {
    const prompt =
      "[scenario check] I looked at `index.html` and the success criteria aren't met yet.";
    expect(isScenarioFileRepairPrompt(prompt)).toBe(true);
    expect(isImmediateFileWriteTurn(prompt, ROSTER)).toBe(false);
  });

  it('treats a bare deliverable line as urgent only once the surface is narrowed', () => {
    const prompt = '[Deliverable expected as a FILE at `notes/plan.md`] — see brief.';
    expect(isImmediateFileWriteTurn(prompt, [tool('write_file')])).toBe(true);
    expect(isImmediateFileWriteTurn(prompt, ROSTER)).toBe(false);
  });
});

describe('tool-surface narrowing', () => {
  it('reduces the roster to write_file alone', () => {
    expect(writeFileOnlyTools(ROSTER).map((t) => t.function.name)).toEqual(['write_file']);
  });

  it('reduces the roster to read_file alone', () => {
    expect(readFileOnlyTools(ROSTER).map((t) => t.function.name)).toEqual(['read_file']);
  });

  it('returns empty rather than inventing a tool that is not on the roster', () => {
    expect(writeFileOnlyTools([tool('read_file')])).toEqual([]);
    expect(writeFileOnlyTools(undefined)).toEqual([]);
  });
});

describe('applyConstrainedTurnShape', () => {
  it('floors the token budget, cools sampling, and disables thinking', () => {
    const body: Record<string, unknown> = { max_tokens: 512, temperature: 1 };
    applyConstrainedTurnShape(body);
    expect(body.max_tokens).toBe(CONSTRAINED_WRITE_MIN_TOKENS);
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.8);
    expect(body.chat_template_kwargs).toMatchObject({ enable_thinking: false });
  });

  it('never lowers a budget that is already generous', () => {
    const body: Record<string, unknown> = { max_tokens: 12_288 };
    applyConstrainedTurnShape(body);
    expect(body.max_tokens).toBe(12_288);
  });

  it('downgrades a declared depth dial and reports it', () => {
    const body: Record<string, unknown> = {
      chat_template_kwargs: { reasoning_effort: 'xhigh' },
    };
    const shape = applyConstrainedTurnShape(body);
    expect(shape.reasoningDepthDowngraded).toEqual(['reasoning_effort']);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false, reasoning_effort: 'low' });
  });

  it('leaves tool_choice and the tool surface to the caller', () => {
    // The engines force a call differently — llama-cpp via tool_choice,
    // MLX via its llguidance grammar — so shaping must not assume either.
    const body: Record<string, unknown> = {};
    applyConstrainedTurnShape(body);
    expect(body.tool_choice).toBeUndefined();
    expect(body.tools).toBeUndefined();
  });
});
