import { describe, expect, it } from 'vitest';
import {
  handoffContextLine,
  handoffHeadline,
  handoffKindLabel,
  handoffPreviewLine,
  handoffSummary,
  humanizeStepId,
  parseTaskHandoffNote,
} from './task-handoff-note.js';

/**
 * The strings below are the four `startHandoffSession` seeds from
 * packages/service/src/chat/manager.ts, verbatim. If a seed is reworded
 * there and not here, the card silently falls back to the raw paragraph —
 * which is the exact regression this suite exists to catch.
 */
const HANDOFF_SEED =
  'Liesel has handed step `review` of task default/11 to you. Follow the step instructions already in your prompt — make the first tool call they name this turn. Append focused notes with `write_task_note` as you go so the next gezel can pick up where you left off. When the step is done, call `advance_task_step` to hand off to whoever’s next.';
const ANON_HANDOFF_SEED =
  'The previous step has been completed and handed step `oversight` of task default/4 to you. Follow the step instructions already in your prompt — make the first tool call they name this turn.';
const ENTRY_SEED =
  'Task default/11 ("Board deck for Q3") was just created from the **Presentation** craftbook. Builds a deck from sources.\n\nIts steps:\n1. Sources — gather them ← your step\n2. Outline\n\nYou\'ve been assigned task default/11 (step `sources`). Follow the step instructions already in your prompt — make the first tool call they name this turn.';
const ADVANCE_SEED =
  'Task default/11 has advanced to the next step — `write-deck`, which is yours as well. Please continue: follow the step instructions already in your prompt — make the first tool call they name this turn.';
const RESUME_SEED =
  'The service restarted while task default/11 was still active on step `review`. Continue this existing task thread from the progress and tool evidence above.';

describe('parseTaskHandoffNote', () => {
  it('reads sender, step and task off a named hand-off', () => {
    expect(parseTaskHandoffNote(HANDOFF_SEED)).toEqual({
      kind: 'handoff',
      taskRef: 'default/11',
      stepId: 'review',
      fromName: 'Liesel',
    });
  });

  it('keeps an unresolved sender anonymous rather than inventing one', () => {
    expect(parseTaskHandoffNote(ANON_HANDOFF_SEED)).toEqual({
      kind: 'handoff',
      taskRef: 'default/4',
      stepId: 'oversight',
    });
  });

  it('reads the craftbook and title off an entry seed with its preface', () => {
    expect(parseTaskHandoffNote(ENTRY_SEED)).toEqual({
      kind: 'entry',
      taskRef: 'default/11',
      stepId: 'sources',
      taskTitle: 'Board deck for Q3',
      craftbook: 'Presentation',
    });
  });

  it('recognises an entry seed whose preface could not be built', () => {
    expect(
      parseTaskHandoffNote("You've been assigned task default/2 (step `scope`). Follow the step"),
    ).toEqual({ kind: 'entry', taskRef: 'default/2', stepId: 'scope' });
  });

  it('recognises a same-gezel step advance', () => {
    expect(parseTaskHandoffNote(ADVANCE_SEED)).toEqual({
      kind: 'advance',
      taskRef: 'default/11',
      stepId: 'write-deck',
    });
  });

  it('recognises a post-restart resume', () => {
    expect(parseTaskHandoffNote(RESUME_SEED)).toEqual({
      kind: 'resume',
      taskRef: 'default/11',
      stepId: 'review',
    });
  });

  it('leaves other machine-authored turns alone', () => {
    expect(parseTaskHandoffNote('The user opened report.md while you were working.')).toBeNull();
    expect(parseTaskHandoffNote('ship it')).toBeNull();
  });
});

describe('handoffHeadline', () => {
  it('names both parties on a hand-off', () => {
    expect(handoffHeadline(parseTaskHandoffNote(HANDOFF_SEED)!, 'Koray')).toBe(
      'Liesel passed the review step to Koray.',
    );
  });

  it('drops to the passive voice when the sender is unknown', () => {
    expect(handoffHeadline(parseTaskHandoffNote(ANON_HANDOFF_SEED)!, 'Koray')).toBe(
      'The oversight step was passed to Koray.',
    );
  });

  it('reads a slug step as prose', () => {
    expect(handoffHeadline(parseTaskHandoffNote(ADVANCE_SEED)!, 'Koray')).toBe(
      'Koray continues with the write deck step.',
    );
    expect(humanizeStepId('write_deck')).toBe('write deck');
  });

  it('says what happened on entry and resume', () => {
    expect(handoffHeadline(parseTaskHandoffNote(ENTRY_SEED)!, 'Maya')).toBe(
      'Maya was assigned the sources step.',
    );
    expect(handoffHeadline(parseTaskHandoffNote(RESUME_SEED)!, 'Maya')).toBe(
      'Maya picked the review step back up after a restart.',
    );
  });
});

describe('handoffContextLine', () => {
  it('names the craftbook a fresh task came from', () => {
    expect(handoffContextLine(parseTaskHandoffNote(ENTRY_SEED)!)).toBe(
      'New task “Board deck for Q3” — Presentation.',
    );
  });

  it('stays empty for a mid-task hand-off', () => {
    expect(handoffContextLine(parseTaskHandoffNote(HANDOFF_SEED)!)).toBe('');
  });
});

describe('handoffKindLabel', () => {
  it('names which of the four dispatch shapes this is', () => {
    expect(handoffKindLabel(parseTaskHandoffNote(HANDOFF_SEED)!)).toBe('Hand-off');
    expect(handoffKindLabel(parseTaskHandoffNote(ENTRY_SEED)!)).toBe('New task');
    expect(handoffKindLabel(parseTaskHandoffNote(ADVANCE_SEED)!)).toBe('Next step');
    expect(handoffKindLabel(parseTaskHandoffNote(RESUME_SEED)!)).toBe('Resumed');
  });
});

describe('handoffSummary / handoffPreviewLine', () => {
  it('states the fact without a receiver for thread-summary surfaces', () => {
    expect(handoffSummary(parseTaskHandoffNote(HANDOFF_SEED)!)).toBe(
      'Liesel passed on the review step.',
    );
    expect(handoffSummary(parseTaskHandoffNote(ANON_HANDOFF_SEED)!)).toBe(
      'The oversight step was passed on.',
    );
    expect(handoffSummary(parseTaskHandoffNote(ADVANCE_SEED)!)).toBe(
      'Continuing with the write deck step.',
    );
  });

  it('still reads an entry seed cut short by the preview bound', () => {
    const cut = ENTRY_SEED.slice(0, 200);
    expect(parseTaskHandoffNote(cut)).toBeNull();
    expect(handoffPreviewLine(cut)).toBe('New task “Board deck for Q3” — Presentation.');
  });

  it('leaves a message that is not a dispatch seed to its caller', () => {
    expect(handoffPreviewLine('Deck is drafted — take a look.')).toBeNull();
  });
});

describe('boring mode', () => {
  /**
   * With role-based names only, the seed's sender is a lowercase role. It
   * opens the sentence, so it must not read "reviewer passed…".
   */
  it('gives a role-named sender sentence case', () => {
    const seed =
      'reviewer has handed step `report` of task p1/1 to you. Follow the step instructions already in your prompt.';
    const note = parseTaskHandoffNote(seed)!;
    expect(note.fromName).toBe('reviewer');
    expect(handoffHeadline(note, 'developer')).toBe(
      'Reviewer passed the report step to developer.',
    );
    expect(handoffSummary(note)).toBe('Reviewer passed on the report step.');
  });
});
