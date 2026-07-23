import type { Question } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { formatAnswerSeed, outstandingSessionQuestion } from './question-format.js';

function makeQuestion(over: Partial<Question> = {}): Question {
  return {
    id: 'q1',
    projectId: 'shop',
    gezelId: 'leo',
    sessionId: 'sess1',
    prompt: "Do you have specific symbols you'd like in the logo?",
    choices: ['Fox', 'Plant', 'Star'],
    allowWriteIn: true,
    multiSelect: true,
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('formatAnswerSeed', () => {
  it('emits a header + Selected + Notes when both are present', () => {
    const q = makeQuestion({
      answer: {
        selectedChoices: [0, 1],
        writeIn: 'warm palette, no text',
        at: '2026-01-01T00:00:01Z',
      },
    });
    expect(formatAnswerSeed(q)).toBe(
      [
        '[Answer to: "Do you have specific symbols you\'d like in the logo?"]',
        'Selected: Fox, Plant',
        'Notes: warm palette, no text',
      ].join('\n'),
    );
  });

  it('omits Notes when there is no write-in', () => {
    const q = makeQuestion({
      answer: { selectedChoices: [2], at: '2026-01-01T00:00:01Z' },
    });
    expect(formatAnswerSeed(q)).toBe(
      [
        '[Answer to: "Do you have specific symbols you\'d like in the logo?"]',
        'Selected: Star',
      ].join('\n'),
    );
  });

  it('omits Selected when only a write-in came back', () => {
    const q = makeQuestion({
      choices: undefined,
      answer: { writeIn: 'fox holding a treat', at: '2026-01-01T00:00:01Z' },
    });
    expect(formatAnswerSeed(q)).toBe(
      [
        '[Answer to: "Do you have specific symbols you\'d like in the logo?"]',
        'Notes: fox holding a treat',
      ].join('\n'),
    );
  });

  it('renders a "proceed with defaults" envelope when the user clicked Just do whatever', () => {
    const q = makeQuestion({
      answer: { declined: true, at: '2026-01-01T00:00:01Z' },
    });
    expect(formatAnswerSeed(q)).toBe(
      '[The user wants you to proceed without their input — use sensible defaults: "Do you have specific symbols you\'d like in the logo?"]',
    );
  });

  it('handles missing-answer defensively', () => {
    const q = makeQuestion({});
    expect(formatAnswerSeed(q)).toContain('proceed without their input');
  });

  it("flags an empty answer body so the gezel doesn't get a bare header", () => {
    const q = makeQuestion({
      answer: { at: '2026-01-01T00:00:01Z' },
    });
    expect(formatAnswerSeed(q)).toContain('(no answer body provided)');
  });

  it('drops invalid choice indices instead of leaking undefineds', () => {
    const q = makeQuestion({
      choices: ['Fox', 'Plant'],
      answer: { selectedChoices: [0, 99], at: '2026-01-01T00:00:01Z' },
    });
    expect(formatAnswerSeed(q)).toBe(
      [
        '[Answer to: "Do you have specific symbols you\'d like in the logo?"]',
        'Selected: Fox',
      ].join('\n'),
    );
  });

  it('collapses multi-line / whitespace-noisy prompts in the header', () => {
    const q = makeQuestion({
      prompt: 'Do you\nhave\n\n  symbols?',
      answer: { selectedChoices: [0], at: '2026-01-01T00:00:01Z' },
    });
    expect(formatAnswerSeed(q)).toContain('[Answer to: "Do you have symbols?"]');
  });
});

describe('outstandingSessionQuestion', () => {
  it('returns undefined when the session has no questions', () => {
    expect(outstandingSessionQuestion([], 'sess1')).toBeUndefined();
  });

  it("finds the session's unanswered intent-less question (blocks a re-ask)", () => {
    const q = makeQuestion({ id: 'q1', sessionId: 'sess1' });
    expect(outstandingSessionQuestion([q], 'sess1')?.id).toBe('q1');
  });

  it('returns the OLDEST match so the user keeps the first card they saw', () => {
    const older = makeQuestion({
      id: 'old',
      sessionId: 'sess1',
      createdAt: '2026-01-01T00:00:00Z',
    });
    const newer = makeQuestion({
      id: 'new',
      sessionId: 'sess1',
      createdAt: '2026-01-01T00:05:00Z',
    });
    // Order in the array shouldn't matter — sort by createdAt wins.
    expect(outstandingSessionQuestion([newer, older], 'sess1')?.id).toBe('old');
  });

  it('ignores answered questions — a follow-up after an answer is allowed', () => {
    const answered = makeQuestion({
      id: 'done',
      sessionId: 'sess1',
      answer: { selectedChoices: [0], at: '2026-01-01T00:00:01Z' },
    });
    expect(outstandingSessionQuestion([answered], 'sess1')).toBeUndefined();
  });

  it("scopes to the session — another session's pending question never blocks", () => {
    const other = makeQuestion({ id: 'other', sessionId: 'sess2' });
    expect(outstandingSessionQuestion([other], 'sess1')).toBeUndefined();
  });

  it('ignores intent-bearing approval cards (npm-install / command / permission)', () => {
    const approval = makeQuestion({
      id: 'npm',
      sessionId: 'sess1',
      intent: {
        kind: 'npm-install-approval',
        packages: [{ package: 'left-pad', version: '1.0.0' }],
      },
    });
    // An outstanding approval card must not suppress a genuine question…
    expect(outstandingSessionQuestion([approval], 'sess1')).toBeUndefined();
    // …and a genuine question is still found alongside one.
    const plain = makeQuestion({ id: 'plain', sessionId: 'sess1' });
    expect(outstandingSessionQuestion([approval, plain], 'sess1')?.id).toBe('plain');
  });
});
