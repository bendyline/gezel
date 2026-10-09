import { describe, expect, it } from 'vitest';
import type { PromptCtx } from '../types.js';
import { PromptToolCookbookFull } from './prompt-tool-cookbook-full.js';

const ctx = (tools: string[], hasPlaywright = false): PromptCtx =>
  ({
    role: 'Developer',
    catalogId: 'qwen3.5-2b-q4',
    tier: 'tiny',
    family: 'qwen',
    modelId: 'qwen3.5-2b-q4',
    providerName: 'llama-cpp',
    hasPlaywright,
    isMeester: false,
    about: '',
    availableToolNames: new Set(tools),
  }) as PromptCtx;
const render = (tools: string[], hasPlaywright = false) =>
  PromptToolCookbookFull.promptAppend!(ctx(tools, hasPlaywright), undefined)!;

describe('the full tool cookbook', () => {
  it('keeps every row and section when the roster is unknown', () => {
    const text = render([], true);
    for (const piece of [
      '`start_project({ name, about, missionObjectives, taskDescription })`',
      '`browser_navigate({ url: "https://..." })`',
      '### Editing a file that already exists',
      '7. **Never paste a full source file',
      '"I have created the project" without calling `start_project`',
      'the previous `browser_navigate` returned an error',
    ])
      expect(text).toContain(piece);
    expect(text).not.toMatch(/\n\n\n/);
  });

  it('names only the tools a lean turn has', () => {
    const text = render(['get_board', 'make_move', 'new_game', 'ask_user_question']);
    for (const absent of [
      'start_project',
      'ensure_gezel',
      'write_artifact',
      'advance_task_step',
      '### Editing a file',
      'Never paste a full source file',
      'browser_navigate`',
    ])
      expect(text).not.toContain(absent);
    expect(text).toContain('`ask_user_question({');
    expect(text).toContain('"I did it" without calling the tool that does it');
    expect(text).not.toMatch(/\n\n\n/);
    expect(text.length / 4).toBeLessThan(1000);
  });

  it('drops the table when no row applies', () => {
    const text = render(['make_move']);
    expect(text).not.toContain('### Cookbook');
    expect(text).toContain('### What NOT to do');
    expect(text).not.toMatch(/\n\n\n/);
  });
});
