/**
 * Coverage for `fabrication.detect-past-tense-no-tools`. The pure
 * detector function and the behavior hook are tested in tandem so
 * the legacy detection contract (`detectHallucinatedToolUse`) is
 * preserved alongside the new postTurnDetector wiring.
 */

import type { ChatMessageToolCall, ProviderName } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { TurnCtx } from '../types.js';
import {
  FabricationDetectPastTense,
  detectHallucinatedToolUse,
} from './fabrication-detect-past-tense.js';

function turnCtx(overrides: Partial<TurnCtx>): TurnCtx {
  return {
    catalogId: 'mistral-7b',
    tier: 'small',
    family: 'mistral',
    modelId: 'mistral-7b',
    providerName: 'ollama' satisfies ProviderName,
    sessionId: 'sess-1',
    isMeester: false,
    userText: '',
    drained: [] as ChatMessageToolCall[],
    assistantContent: '',
    continuationCount: 0,
    ...overrides,
  };
}

describe('detectHallucinatedToolUse', () => {
  it('triggers on past-tense action verbs with no tool calls', () => {
    const v = detectHallucinatedToolUse({
      text: 'I have navigated to The New York Times homepage. Here is the summary.',
      successfulToolCallCount: 0,
    });
    expect(v.hallucinated).toBe(true);
    expect(v.actionVerbHit).toMatch(/I have navigated/i);
  });

  it('triggers on the wild-caught Yusuf Meester pattern', () => {
    const text =
      'I have successfully loaded the page and taken a snapshot.\n\nGlobal Focus: Major developments in [Region X] regarding [Topic Y] dominated international coverage.\n\nDomestic Politics: Key legislative debates are underway concerning [Policy Z], with differing viewpoints dominating the front page.';
    const v = detectHallucinatedToolUse({ text, successfulToolCallCount: 0 });
    expect(v.hallucinated).toBe(true);
    expect(v.placeholders.length).toBeGreaterThanOrEqual(2);
    expect(v.actionVerbHit).toBeTruthy();
  });

  it('triggers on two or more distinct placeholders alone', () => {
    const v = detectHallucinatedToolUse({
      text: 'The result is [Some Value] and the breakdown is [Other Detail].',
      successfulToolCallCount: 0,
    });
    expect(v.hallucinated).toBe(true);
    expect(v.placeholders).toEqual(expect.arrayContaining(['Some Value', 'Other Detail']));
  });

  it('does NOT trigger when a real tool call fired this turn', () => {
    const v = detectHallucinatedToolUse({
      text: 'I have navigated to the homepage and here is what I found.',
      successfulToolCallCount: 1,
    });
    expect(v.hallucinated).toBe(false);
  });

  it('does NOT trigger on a single placeholder (legitimate prose)', () => {
    const v = detectHallucinatedToolUse({
      text: 'Set the [User] variable in your config.',
      successfulToolCallCount: 0,
    });
    expect(v.hallucinated).toBe(false);
  });

  it('does NOT trigger on numeric brackets (citations, years)', () => {
    const v = detectHallucinatedToolUse({
      text: 'According to the [2024] report, the trend continued in [2025].',
      successfulToolCallCount: 0,
    });
    expect(v.hallucinated).toBe(false);
    expect(v.placeholders).toEqual([]);
  });

  it('does NOT trigger on markdown links', () => {
    const v = detectHallucinatedToolUse({
      text: 'See [the docs](https://example.com) and [the FAQ](https://example.com/faq).',
      successfulToolCallCount: 0,
    });
    expect(v.hallucinated).toBe(false);
  });

  it('does NOT trigger on plain prose without action verbs or placeholders', () => {
    const v = detectHallucinatedToolUse({
      text: "Hello! I'm Yusuf, the concierge. How can I help today?",
      successfulToolCallCount: 0,
    });
    expect(v.hallucinated).toBe(false);
  });

  it("catches 'I've successfully retrieved' framing", () => {
    const v = detectHallucinatedToolUse({
      text: "I've successfully retrieved the data. The summary is below.",
      successfulToolCallCount: 0,
    });
    expect(v.hallucinated).toBe(true);
  });

  it("catches 'I just downloaded' framing", () => {
    const v = detectHallucinatedToolUse({
      text: 'I just downloaded the file you requested.',
      successfulToolCallCount: 0,
    });
    expect(v.hallucinated).toBe(true);
  });

  it("catches the verbatim Meester (Kenji) fabrication: 'I've kicked off the project'", () => {
    // Wild-caught on a Meester running on gemma4-26b (MLX, medium
    // tier). The model wrote a past-tense success claim without
    // calling `start_project`; no project was created, no voorman
    // assigned, but the user saw a confident "I've kicked off…"
    // bubble. The detector previously missed it because (a) tier
    // `medium` had no behaviors by default and (b) "kicked off"
    // wasn't in the verb list. Both gaps are now closed.
    const v = detectHallucinatedToolUse({
      text: "I've kicked off the project for your side-scroller. A voorman is now leading the crew and will begin setting up the core game engine and movement mechanics.",
      successfulToolCallCount: 0,
    });
    expect(v.hallucinated).toBe(true);
    expect(v.actionVerbHit).toMatch(/kicked off/i);
  });

  it("catches the Meester team-management lexicon ('spun up', 'recruited', 'wired in', 'assigned', 'spawned', 'started', 'set up')", () => {
    const samples = [
      "I've spun up a designer for the logo work.",
      "I've recruited a developer to lead the build.",
      "I've wired in Vivian as the voorman of the project.",
      "I've assigned the task to Leo.",
      "I've spawned a fresh voorman to take this on.",
      "I've started the project and the team is ready.",
      "I've set up the project structure and the kickoff task.",
    ];
    for (const text of samples) {
      const v = detectHallucinatedToolUse({ text, successfulToolCallCount: 0 });
      expect(v.hallucinated, `expected fabrication for: ${text}`).toBe(true);
      expect(v.actionVerbHit, `expected verb hit for: ${text}`).toBeTruthy();
    }
  });

  it('does NOT trigger on team-management verbs when a tool actually fired', () => {
    // Counterpart of the lexicon test. If `start_project` /
    // `ensure_gezel` / `assign_task` succeeded this turn, "I've kicked
    // off the project" is the truthful narration, not a fabrication.
    const v = detectHallucinatedToolUse({
      text: "I've kicked off the project — Vivian is leading the crew.",
      successfulToolCallCount: 1,
    });
    expect(v.hallucinated).toBe(false);
  });

  it('catches third-person fabrication: "The specialist has weighed in..."', () => {
    // Wild-caught on Breno-the-Developer (gemma4-26b/MLX):
    // `ask_specialist` failed with reason=self, model retried, both
    // failed, then emitted "The specialist has weighed in with a
    // breakdown of the top three options:" followed by a fully
    // fabricated Phaser/Godot/Unity comparison table. The first-
    // person regex misses this — no "I have" framing — but the
    // third-person regex catches "The specialist has weighed in".
    const v = detectHallucinatedToolUse({
      text: 'The specialist has weighed in with a breakdown of the top three options based on your specific requirements:\n\n### Technical Stack Comparison',
      successfulToolCallCount: 0,
    });
    expect(v.hallucinated).toBe(true);
    expect(v.actionVerbHit).toMatch(/specialist.*weighed in/i);
  });

  it('catches third-person fabrications across the result-noun + verb matrix', () => {
    const fabrications = [
      'The expert recommended a stateless architecture for this case.',
      'The consultant suggested splitting the bundle into three chunks.',
      'The advisor answered with a clear preference for option B.',
      'The tool delivered the requested file metadata below.',
      'The analysis confirmed the bottleneck is in the render path.',
      'The response indicated a 30% improvement is achievable.',
      'The reply has provided a step-by-step migration plan.',
      'The search delivered seven matching documents.',
    ];
    for (const text of fabrications) {
      const v = detectHallucinatedToolUse({ text, successfulToolCallCount: 0 });
      expect(v.hallucinated, `expected fabrication for: ${text}`).toBe(true);
    }
  });

  it('does NOT false-positive on legitimate error acknowledgement', () => {
    // The strict-verb pattern excludes "the tool returned an error"
    // (the verb requires a content-delivery shape, not an error
    // shape). Legitimate prose acknowledging the failure should pass.
    const v = detectHallucinatedToolUse({
      text: "The previous `ask_specialist` call returned an error (`reason: self`). I'll answer directly.",
      successfulToolCallCount: 0,
    });
    expect(v.hallucinated).toBe(false);
  });

  it('does NOT trigger third-person when at least one real tool fired', () => {
    const v = detectHallucinatedToolUse({
      text: 'The specialist has weighed in with their answer below.',
      successfulToolCallCount: 1,
    });
    expect(v.hallucinated).toBe(false);
  });

  it('deduplicates placeholders so the same one twice is still counted as one', () => {
    const v = detectHallucinatedToolUse({
      text: 'Use the [User] config or override the [User] env var.',
      successfulToolCallCount: 0,
    });
    expect(v.hallucinated).toBe(false);
    expect(v.placeholders).toEqual(['User']);
  });
});

describe('FabricationDetectPastTense behavior hook', () => {
  it('returns a warn-only verdict when fabrication is detected and no tools fired', () => {
    const verdict = FabricationDetectPastTense.postTurnDetector!(
      turnCtx({
        assistantContent: 'I have navigated to the homepage and read the latest news.',
        drained: [],
      }),
      undefined,
    );
    expect(verdict).not.toBeNull();
    expect(verdict?.warnUser).toBe(true);
    expect(verdict?.promptForNextTurn).toBeUndefined();
    expect(verdict?.reason).toContain('fabricated tool results');
  });

  it('passes when at least one tool fired successfully', () => {
    const verdict = FabricationDetectPastTense.postTurnDetector!(
      turnCtx({
        assistantContent: 'I have read the file.',
        drained: [{ name: 'read_artifact', durationMs: 12, success: true } as ChatMessageToolCall],
      }),
      undefined,
    );
    expect(verdict).toBeNull();
  });

  it('still fires when every tool call errored (model claims success despite failure)', () => {
    const verdict = FabricationDetectPastTense.postTurnDetector!(
      turnCtx({
        assistantContent: 'I have navigated to the homepage and here is what I found.',
        drained: [
          { name: 'browser_navigate', durationMs: 12, success: false } as ChatMessageToolCall,
        ],
      }),
      undefined,
    );
    expect(verdict).not.toBeNull();
    expect(verdict?.warnUser).toBe(true);
  });
});
