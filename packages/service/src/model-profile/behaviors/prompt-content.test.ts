/**
 * Smoke tests for the prompt-content behaviors. Each is a
 * mostly-static prose constant; the tests verify the behavior fires
 * its hook + emits stable, recognizable content. Detailed copy
 * coverage isn't worth re-asserting — the strings are migrated
 * verbatim from `local-model-tuning.ts` and any drift would show up
 * as a load-bearing test failure in the chat manager's behavior
 * tests once Step 5 wires this up.
 */

import type { ChatMessageToolCall, ProviderName } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { PromptCtx } from '../types.js';
import { PromptDeriveByExecution } from './prompt-derive-by-execution.js';
import { PromptPreferWritefileEdits } from './prompt-prefer-writefile-edits.js';
import { PromptPrivateReasoningGuidance } from './prompt-private-reasoning-guidance.js';
import { PromptTerseVisibleReply } from './prompt-terse-visible-reply.js';
import { PromptToolCookbookCondensed } from './prompt-tool-cookbook-condensed.js';
import { PromptToolCookbookFull } from './prompt-tool-cookbook-full.js';
import { PromptVerboseReasoningHintChannel } from './prompt-verbose-reasoning-hint-channel.js';
import { PromptVerboseReasoningHintThink } from './prompt-verbose-reasoning-hint-think.js';

function promptCtx(overrides: Partial<PromptCtx>): PromptCtx {
  return {
    catalogId: 'gemma4-26b',
    tier: 'medium',
    family: 'gemma',
    modelId: 'gemma4-26b',
    providerName: 'mlx' satisfies ProviderName,
    hasPlaywright: false,
    isMeester: false,
    about: 'Test about',
    ...overrides,
  };
}

describe('PromptToolCookbookFull', () => {
  it('emits the cookbook with the browse row hidden when hasPlaywright is false', () => {
    const out = PromptToolCookbookFull.promptAppend!(
      promptCtx({ hasPlaywright: false }),
      undefined,
    );
    expect(out).toContain('Cookbook — common patterns');
    expect(out).toContain('start_project');
    expect(out).not.toContain('create_project');
    // The conditional row mentions "fetch / look up / browse / read this URL"
    // and instructs `browser_navigate({ url })`. browser_find_page_element
    // is unconditional and stays.
    expect(out).not.toContain('fetch / look up / browse / read this URL');
  });

  it('renders the browse row when hasPlaywright is true', () => {
    const out = PromptToolCookbookFull.promptAppend!(promptCtx({ hasPlaywright: true }), undefined);
    expect(out).toContain('fetch / look up / browse / read this URL');
    expect(out).toContain('browser_navigate({ url:');
  });

  it('includes the anti-fabrication "What NOT to do" rules', () => {
    const out = PromptToolCookbookFull.promptAppend!(promptCtx({}), undefined);
    expect(out).toContain('Never claim past-tense action without a tool call this turn.');
    expect(out).toContain('Never write placeholder content');
    expect(out).toContain('write it via `write_file`');
    expect(out).toContain('not a workspace/source file');
    expect(out).not.toContain('write_file` (or `write_artifact`)');
  });

  it("includes the patch-don't-re-emit edit guidance steering to replace_lines", () => {
    const out = PromptToolCookbookFull.promptAppend!(promptCtx({}), undefined);
    expect(out).toContain('Editing a file that already exists');
    expect(out).toContain('replace_lines');
    expect(out).toContain('N→');
  });
});

describe('PromptToolCookbookCondensed', () => {
  it('emits the 10-rule condensed cookbook', () => {
    const out = PromptToolCookbookCondensed.promptAppend!(promptCtx({}), undefined);
    expect(out).toContain('anti-fabrication rules');
    expect(out).toContain('Never claim past-tense action');
    expect(out).toContain('Markup is not a tool call');
    expect(out).toContain('If the path appears under "Workspace files"');
    expect(out).toContain('write it via `write_file`');
    expect(out).not.toContain('write_file` (or `write_artifact`)');
    // Rule 10: the patch-don't-re-emit edit nudge.
    expect(out).toContain("Patch it, don't re-emit");
    expect(out).toContain('replace_lines');
  });

  it('does not include the full cookbook table', () => {
    const out = PromptToolCookbookCondensed.promptAppend!(promptCtx({}), undefined);
    expect(out).not.toContain('Cookbook — common patterns');
  });
});

describe('PromptPrivateReasoningGuidance', () => {
  it('stays registered for manifest compatibility without injecting prompt text', () => {
    expect(PromptPrivateReasoningGuidance.promptAppend).toBeUndefined();
  });
});

describe('legacy verbose reasoning prompt aliases', () => {
  it('stay registered without injecting retired prompt coaching', () => {
    expect(PromptVerboseReasoningHintChannel.promptAppend).toBeUndefined();
    expect(PromptVerboseReasoningHintThink.promptAppend).toBeUndefined();
  });
});

describe('PromptPreferWritefileEdits', () => {
  it('steers to positional line-number edits (replace_lines) and overrides the patch guidance', () => {
    const out = PromptPreferWritefileEdits.promptAppend!(promptCtx({}), undefined);
    expect(out).toContain('edit by line number');
    expect(out).toContain('replace_lines');
    expect(out).toContain('OVERRIDES');
    expect(out).toContain('Avoid `replace_in_file`');
    expect(out).toContain('byte-for-byte');
  });
});

describe('PromptTerseVisibleReply', () => {
  it('tells the model to keep the visible reply short and act, not narrate', () => {
    const out = PromptTerseVisibleReply.promptAppend!(promptCtx({}), undefined);
    expect(out).toContain('Keep the visible reply short');
    expect(out).toContain('conclusion plus the action');
    expect(out).toContain('Never repeat an analysis you already gave');
  });
});

describe('PromptDeriveByExecution', () => {
  it('steers derived data outputs to script execution and carves out prose work', () => {
    const out = PromptDeriveByExecution.promptAppend!(promptCtx({}), undefined);
    expect(out).toContain('Derived data outputs');
    expect(out).toContain('derive_file');
    expect(out).toContain('run_nodejs_script');
    expect(out).toContain('Hand-typing rows loses data');
    expect(out).toContain('Reports and prose that merely cite data');
  });
});

describe('TurnCtx unused parameter sanity', () => {
  it('drained array type matches ChatMessageToolCall', () => {
    // Compile-time check: TypeScript would fail this if the type signatures
    // drifted across behavior files.
    const _: ChatMessageToolCall[] = [];
    expect(_).toEqual([]);
  });
});
