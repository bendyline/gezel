/**
 * Coverage for the `prompt.meester-craftbook-prelude` behavior:
 * gating (meester + procedure/recurrence language), the select-vs-
 * author split, and the regex positive/negative cases — including
 * the non-overlap contract with the build prelude (generic "build me
 * X" turns must stay with `start_project`).
 */

import type { ChatMessageToolCall, ProviderName } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { TurnCtx } from '../types.js';
import { looksLikeNewBuildRequest } from './prompt-meester-build-prelude.js';
import {
  PromptMeesterCraftbookPrelude,
  looksLikeDataTransformRequest,
  looksLikeLibraryLookupRequest,
  looksLikeProcedureRequest,
} from './prompt-meester-craftbook-prelude.js';

function turnCtx(overrides: Partial<TurnCtx>): TurnCtx {
  return {
    catalogId: 'qwen3.6-27b-q4',
    tier: 'medium',
    family: 'qwen',
    modelId: 'qwen3.6-27b-q4',
    providerName: 'llama-cpp' satisfies ProviderName,
    sessionId: 'sess-1',
    isMeester: true,
    projectId: 'default',
    messageOrigin: 'direct-user',
    availableToolNames: ['craftbook_create', 'suggest_craftbook', 'invoke_craftbook'],
    userText: '',
    drained: [] as ChatMessageToolCall[],
    assistantContent: '',
    continuationCount: 0,
    ...overrides,
  };
}

const fire = (userText: string) =>
  PromptMeesterCraftbookPrelude.userPromptPrelude!(turnCtx({ userText }), undefined);

describe('PromptMeesterCraftbookPrelude', () => {
  it('fires the AUTHOR note for the wild-caught A/B ask (reusable recipe)', () => {
    const out = fire(
      'We keep getting messy order exports. I want a repeatable recipe for this, not a one-off fix.',
    );
    expect(out).not.toBeNull();
    expect(out).toContain('craftbook_write');
    expect(out).toContain('suggest_craftbook');
    expect(out).toContain('Do NOT delegate the authoring');
  });

  it('fires the SELECT note when the user points at the recipe library', () => {
    const out = fire(
      'Check the recipe library first — if an existing craftbook covers page metadata, use it.',
    );
    expect(out).not.toBeNull();
    expect(out).toContain('suggest_craftbook');
    expect(out).toContain('invoke_craftbook');
    expect(out).not.toContain('craftbook_write');
  });

  it('fires on recurrence phrasing without a procedure noun', () => {
    const out = fire('Every Monday I need the quarterly numbers summarized for the team.');
    expect(out).not.toBeNull();
    expect(out).toContain('craftbook_write');
  });

  it('stays silent for non-meester gezels', () => {
    const out = PromptMeesterCraftbookPrelude.userPromptPrelude!(
      turnCtx({ isMeester: false, userText: 'I want a repeatable recipe for this.' }),
      undefined,
    );
    expect(out).toBeNull();
  });

  it('stays silent on one-off asks (no procedure or recurrence language)', () => {
    expect(fire('Can we create a new Space Invaders game?')).toBeNull();
    expect(fire('Fix the typo in the About page.')).toBeNull();
    expect(fire('I trust the process, just ship it.')).toBeNull();
    expect(fire('Add an Acceptance Criteria Checklist to notes/outline.md.')).toBeNull();
  });

  it('stays silent for cross-gezel file handoffs even when their criteria mention a workflow', () => {
    expect(
      fire(
        '[Message from Daehyun]: Add a workflow checklist to the outline.\n\n' +
          '[Deliverable expected as a FILE at `notes/outline.md`. Your first assistant action should be the tool call `write_file({ path, content })`.]',
      ),
    ).toBeNull();
  });

  it('still treats an explicitly reusable checklist as a repeatable procedure', () => {
    expect(fire('Create a reusable checklist for every launch.')).toContain('craftbook_write');
  });

  it("does not claim the build prelude's generic build turns (non-overlap contract)", () => {
    const genericBuild = 'Can we create a new Space Invaders game?';
    expect(looksLikeNewBuildRequest(genericBuild)).toBe(true);
    expect(fire(genericBuild)).toBeNull();
  });
});

describe('procedure/library regexes', () => {
  it('positive procedure cases', () => {
    for (const text of [
      'author a reusable craftbook for csv cleanup',
      'we need a playbook for incident comms',
      'set up a standard procedure for onboarding',
      'a process for handling refunds',
      'a workflow to publish the newsletter',
      'this is recurring work',
      'run this on a schedule',
      'I need this whenever a client signs up',
    ]) {
      expect(looksLikeProcedureRequest(text), text).toBe(true);
    }
  });

  it('negative procedure cases (incidental uses)', () => {
    for (const text of [
      'trust the process, ship it',
      'my workflow is blocked today',
      'build me a website',
      'what did we ship each quarter?',
      'add an acceptance criteria checklist to the outline',
    ]) {
      expect(looksLikeProcedureRequest(text), text).toBe(false);
    }
  });

  it('library lookup detection', () => {
    expect(looksLikeLibraryLookupRequest('check the recipe library first')).toBe(true);
    expect(looksLikeLibraryLookupRequest('reuse an existing craftbook if one fits')).toBe(true);
    expect(looksLikeLibraryLookupRequest('which craftbook covers SEO?')).toBe(true);
    expect(looksLikeLibraryLookupRequest('author a new recipe for this')).toBe(false);
  });
});

describe('looksLikeDataTransformRequest (one-off transform-class gating)', () => {
  it('fires on transform verb + data noun across phrasings', () => {
    for (const text of [
      'Please clean up the three raw CSV exports into one customers file',
      'normalize and dedupe these records',
      'Can you consolidate the registration spreadsheets?',
      'convert this dataset to JSON and tidy the dates',
      'merge the two exports and standardize emails',
    ]) {
      expect(looksLikeDataTransformRequest(text), text).toBe(true);
    }
  });

  it('stays quiet without the noun, without the verb, and on unrelated cleanup', () => {
    for (const text of [
      'clean up the wording in the intro paragraph',
      'open the csv and tell me what is inside',
      'build me a tic tac toe game',
      'tidy your desk',
      'what does normalization mean?',
    ]) {
      expect(looksLikeDataTransformRequest(text), text).toBe(false);
    }
  });

  it('returns the transform prelude for a meester, after procedure/library branches', () => {
    const out = PromptMeesterCraftbookPrelude.userPromptPrelude!(
      turnCtx({ userText: 'Please dedupe and normalize the customer csv exports' }),
      undefined,
    );
    expect(out).toContain('data-transform job');
    expect(out).toContain('suggest_craftbook');
  });
});
