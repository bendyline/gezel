import { describe, expect, it } from 'vitest';
import {
  CRAFTBOOK_FOCUS_BUILTIN_TOOLS,
  renderCraftbookFocusBlock,
  renderCraftbookTurnLine,
} from './craftbook-focus.js';

describe('renderCraftbookFocusBlock', () => {
  it('names the book and every editing tool the session holds', () => {
    const block = renderCraftbookFocusBlock({
      id: 'weekly-review',
      name: 'Weekly review',
      toolNames: CRAFTBOOK_FOCUS_BUILTIN_TOOLS,
    });
    expect(block).toContain('the craftbook "Weekly review" (`weekly-review`)');
    expect(block).toContain('`craftbook_update_step`');
    expect(block).toContain('`set_step_deliverable`');
    expect(block).toContain('`how_do_i`');
    expect(block).toContain("Your role's standing duties do not apply");
  });

  it('names only tools the session was given', () => {
    const block = renderCraftbookFocusBlock({
      id: 'weekly-review',
      toolNames: ['craftbook_read', 'craftbook_write'],
    });
    expect(block).toContain('the craftbook `weekly-review`');
    for (const absent of ['set_step_deliverable', 'list_gilde', 'how_do_i', 'list_craftbooks']) {
      expect(block).not.toContain(absent);
    }
    expect(block).toContain('(a deliverable or a gate)');
  });
});

describe('renderCraftbookTurnLine', () => {
  const book = {
    id: 'weekly-review',
    name: 'Weekly "review"',
    entryStepId: 'gather',
    steps: [
      {
        id: 'gather',
        name: 'Gather',
        suggestedRole: 'researcher',
        advanceWhen: { file: 'tasks/1/notes.md' },
      },
      { id: 'send', name: 'Send', assignee: { kind: 'user' as const } },
      { id: 'tidy', name: 'Tidy' },
    ],
  };

  it('outlines the book as it stands', () => {
    const line = renderCraftbookTurnLine(book, []);
    expect(line.startsWith(`[The craftbook "Weekly 'review'" (\`weekly-review\`)`)).toBe(true);
    expect(line).toContain('1. Gather (`gather`, entry): researcher; writes tasks/1/notes.md');
    expect(line).toContain('2. Send (`send`): the person');
    expect(line).toContain('3. Tidy (`tidy`): no role');
    expect(line).toContain('Checkup: nothing to flag.');
    expect(line.endsWith(']')).toBe(true);
  });

  it('lists findings and counts the rest', () => {
    const findings = Array.from({ length: 10 }, (_, i) => ({ kind: 'k', message: `Finding ${i}` }));
    const line = renderCraftbookTurnLine(book, findings);
    expect(line).toContain('- Finding 7');
    expect(line).not.toContain('Finding 8');
    expect(line).toContain('- …and 2 more.');
  });
});
