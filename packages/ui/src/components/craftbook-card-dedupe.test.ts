import type { ToolCallCard } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { craftbookCardDedupe, liveCardsToHide } from './craftbook-card-dedupe.js';

function start(taskRef: string, reused = false): ToolCallCard {
  return {
    kind: 'craftbook-start',
    craftbookId: 'report-pdf',
    craftbookName: 'Formatted Report',
    taskRef,
    projectId: 'bakery',
    status: 'active',
    steps: [{ id: 'outline', name: 'Outline the report', status: 'active' }],
    ...(reused ? { reused: true } : {}),
  };
}

function advance(taskRef: string): ToolCallCard {
  return {
    kind: 'task-step-advance',
    craftbookId: 'report-pdf',
    craftbookName: 'Formatted Report',
    taskRef,
    projectId: 'bakery',
    status: 'active',
    completedStepId: 'outline',
    activeStepId: 'write',
    steps: [
      { id: 'outline', name: 'Outline the report', status: 'done' },
      { id: 'write', name: 'Write the report', status: 'active' },
    ],
  };
}

describe('craftbookCardDedupe', () => {
  // The bakery turn: one start and two idempotent re-invocations.
  it('keeps the first card of a task and hides its repeats', () => {
    const first = start('bakery/2');
    const again = start('bakery/2', true);
    const andAgain = start('bakery/2', true);
    const { hidden, owned } = craftbookCardDedupe([
      { toolCalls: [{ card: first }, { card: again }, { card: andAgain }] },
    ]);
    expect([...hidden]).toEqual([again, andAgain]);
    expect([...owned]).toEqual(['bakery/2']);
  });

  it('hides a later step-complete card for a task that already has one', () => {
    const first = start('bakery/2');
    const step = advance('bakery/2');
    const { hidden } = craftbookCardDedupe([
      { toolCalls: [{ card: first }] },
      { toolCalls: [{}, { card: step }] },
    ]);
    expect(hidden.has(step)).toBe(true);
    expect(hidden.has(first)).toBe(false);
  });

  it('shows an "already running" card that is the only one in view', () => {
    const lone = start('bakery/2', true);
    expect(craftbookCardDedupe([{ toolCalls: [{ card: lone }] }]).hidden.size).toBe(0);
  });

  it('keeps one card for each separate task', () => {
    const a = start('bakery/1');
    const b = start('bakery/2');
    expect(craftbookCardDedupe([{ toolCalls: [{ card: a }, { card: b }] }]).hidden.size).toBe(0);
  });

  it('ignores messages without cards', () => {
    expect(craftbookCardDedupe([{}, { toolCalls: [] }]).owned.size).toBe(0);
  });
});

describe('liveCardsToHide', () => {
  it('hides a live card for a task an earlier card already stands for', () => {
    const live = start('bakery/2', true);
    expect(liveCardsToHide([{ card: live }], new Set(['bakery/2'])).has(live)).toBe(true);
  });

  it('applies the same rule within the live turn itself', () => {
    const first = start('bakery/3');
    const again = start('bakery/3', true);
    const hidden = liveCardsToHide([{ card: first }, { card: again }], new Set());
    expect([...hidden]).toEqual([again]);
  });
});
