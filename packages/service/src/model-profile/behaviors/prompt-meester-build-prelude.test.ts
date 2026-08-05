/**
 * Coverage for the `prompt.meester-build-prelude` behavior. Asserts
 * the gating (meester + build-shaped user message) and the regex
 * positive/negative cases that earlier lived in
 * `chat/build-request-detector.test.ts` — moved here so the test
 * lives next to the implementation.
 */

import type { ChatMessageToolCall, ProviderName } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { TurnCtx } from '../types.js';
import { lintPromptToolContract } from '../../chat/prompt-tool-contract.js';
import {
  PromptMeesterBuildPrelude,
  looksLikeNewBuildRequest,
} from './prompt-meester-build-prelude.js';

function turnCtx(overrides: Partial<TurnCtx>): TurnCtx {
  return {
    catalogId: 'gemma4-26b',
    tier: 'medium',
    family: 'gemma',
    modelId: 'gemma4-26b',
    providerName: 'mlx' satisfies ProviderName,
    sessionId: 'sess-1',
    isMeester: true,
    userText: '',
    drained: [] as ChatMessageToolCall[],
    assistantContent: '',
    continuationCount: 0,
    ...overrides,
  };
}

describe('PromptMeesterBuildPrelude', () => {
  it('fires for the wild-caught Cosima/Space Invaders user turn', () => {
    const out = PromptMeesterBuildPrelude.userPromptPrelude!(
      turnCtx({ userText: 'Can we create a new Space Invaders game?' }),
      undefined,
    );
    expect(out).not.toBeNull();
    expect(out).toContain('start_project');
    expect(out).not.toContain('start_job');
    expect(out).toContain('appropriate lead/team');
  });

  it('uses the same start_project macro for single-file no-build requests', () => {
    const out = PromptMeesterBuildPrelude.userPromptPrelude!(
      turnCtx({
        userText:
          'Create a browser-based tic-tac-toe game in a single HTML file. Keep everything in index.html. No build step.',
      }),
      undefined,
    );
    expect(out).not.toBeNull();
    expect(out).toContain('`start_project({');
    expect(out).not.toContain('start_job');
    expect(out).toContain('name `index.html`');
    expect(out).toContain('do not prefix `workspace/`');
  });

  it('matches its effective tool surface', () => {
    const out = PromptMeesterBuildPrelude.userPromptPrelude!(
      turnCtx({ userText: 'Can you create a Frogger-style browser game?' }),
      undefined,
    );
    expect(out).not.toBeNull();
    expect(lintPromptToolContract({ prompt: out!, availableTools: ['start_project'] })).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it('does not fire when the active gezel is not the Meester', () => {
    const out = PromptMeesterBuildPrelude.userPromptPrelude!(
      turnCtx({ userText: "Let's build a marketing site", isMeester: false }),
      undefined,
    );
    expect(out).toBeNull();
  });

  it('does not fire on a non-build user prompt', () => {
    const out = PromptMeesterBuildPrelude.userPromptPrelude!(
      turnCtx({ userText: 'What time is it in Amsterdam?' }),
      undefined,
    );
    expect(out).toBeNull();
  });
});

describe('looksLikeNewBuildRequest — positive matches', () => {
  it('matches the wild-caught "Can we create a new Space Invaders game?"', () => {
    expect(looksLikeNewBuildRequest('Can we create a new Space Invaders game?')).toBe(true);
  });

  it('matches "Let\'s build a marketing site"', () => {
    expect(looksLikeNewBuildRequest("Let's build a marketing site")).toBe(true);
  });

  it('matches "I want to make an app for tracking workouts"', () => {
    expect(looksLikeNewBuildRequest('I want to make an app for tracking workouts')).toBe(true);
  });

  it('matches "help me build a tool that…"', () => {
    expect(looksLikeNewBuildRequest('help me build a tool that monitors disk space')).toBe(true);
  });

  it('matches "spin up a new dashboard"', () => {
    expect(looksLikeNewBuildRequest('spin up a new dashboard')).toBe(true);
  });

  it('matches "I\'d like to start a project for the changelog"', () => {
    expect(looksLikeNewBuildRequest("I'd like to start a project for the changelog")).toBe(true);
  });

  it('matches "kick off a new service"', () => {
    expect(looksLikeNewBuildRequest('kick off a new service for stripe webhooks')).toBe(true);
  });

  it('matches a bare "create a website"', () => {
    expect(looksLikeNewBuildRequest('create a website')).toBe(true);
  });

  it('matches "scaffold a CLI"', () => {
    expect(looksLikeNewBuildRequest('scaffold a CLI for managing my notes')).toBe(true);
  });
});

describe('looksLikeNewBuildRequest — negative matches', () => {
  it('does NOT match "create a task"', () => {
    expect(looksLikeNewBuildRequest('create a task to update the README')).toBe(false);
  });

  it('does NOT match "create a gezel"', () => {
    expect(looksLikeNewBuildRequest("let's create a gezel for design reviews")).toBe(false);
  });

  it('does NOT match "save a memory"', () => {
    expect(looksLikeNewBuildRequest('please save a memory about my preferences')).toBe(false);
  });

  it('does NOT match "write me a note"', () => {
    expect(looksLikeNewBuildRequest('write me a note summarizing the meeting')).toBe(false);
  });

  it('does NOT match a question without a build verb', () => {
    expect(looksLikeNewBuildRequest('What do you know about Space Invaders?')).toBe(false);
  });

  it('does NOT match "set up a meeting"', () => {
    expect(looksLikeNewBuildRequest("Let's set up a meeting for tomorrow")).toBe(false);
  });

  it('does NOT match an empty / whitespace string', () => {
    expect(looksLikeNewBuildRequest('')).toBe(false);
    expect(looksLikeNewBuildRequest('   \n  ')).toBe(false);
  });
});
