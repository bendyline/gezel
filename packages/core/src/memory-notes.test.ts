import { describe, expect, it } from 'vitest';
import {
  MEMORY_NOTES_HEADER,
  memoryNoteLine,
  memoryScopeOfSource,
  noteRepeatsInMessage,
  renderMemoryNotes,
  renderPersonNotesBlock,
  selectPersonNotes,
} from './memory-notes.js';
import { buildInstructions } from './prompt/instructions.js';

describe('memory notes', () => {
  it('reads as the crew’s own notes, naming the kind unless it is a plain fact', () => {
    expect(
      memoryNoteLine({
        scope: 'gezel',
        kind: 'correction',
        day: '2026-10-01',
        text: 'Said "soy cansado";\n it is "estoy cansado".',
      }),
    ).toBe('- Your note (correction, 2026-10-01): Said "soy cansado"; it is "estoy cansado".');
    expect(memoryNoteLine({ scope: 'user', kind: 'fact', text: 'Lives in Utrecht.' })).toBe(
      '- About the person: Lives in Utrecht.',
    );
    expect(renderMemoryNotes(['- x']).split('\n')[0]).toBe(MEMORY_NOTES_HEADER);
    expect(MEMORY_NOTES_HEADER).not.toMatch(/untrusted/i);
  });

  it('says when the message repeats the mistake a correction records, and lists it first', () => {
    const correction = {
      scope: 'gezel' as const,
      kind: 'correction' as const,
      day: '2026-10-01',
      text: 'Sam builds gustar like English: "yo gusto el café" should be "me gusta el café".',
    };
    const message = 'Sí. Yo soy cansado y YO GUSTO el café con leche.';
    expect(noteRepeatsInMessage(correction, message)).toBe(true);
    expect(noteRepeatsInMessage(correction, 'Me gusta el café con leche.')).toBe(false);
    expect(noteRepeatsInMessage({ ...correction, kind: 'pref' }, message)).toBe(false);
    const block = renderMemoryNotes([
      memoryNoteLine({ scope: 'user', text: 'Enjoys café role-plays.' }, message),
      memoryNoteLine(correction, message),
    ]);
    expect(block.split('\n')[1]).toBe(
      '- Your note (correction, 2026-10-01) — this message repeats it: Sam builds gustar like English: "yo gusto el café" should be "me gusta el café".',
    );
  });

  it('maps only the memory corpora to a scope', () => {
    expect(memoryScopeOfSource('user-memory')).toBe('user');
    expect(memoryScopeOfSource('project-memory')).toBe('project');
    expect(memoryScopeOfSource('workspace')).toBeNull();
  });
});

describe('the standing notes about the person', () => {
  const entries = [
    { text: 'Prefers short exchanges.', kind: 'pref' as const, day: '2026-09-01' },
    { text: 'Is travelling to Valencia in May.', kind: 'fact' as const, day: '2026-10-01' },
    { text: 'Is tired this week.', kind: 'status' as const, day: '2026-10-06' },
    { text: 'A menu first worked well.', kind: 'example' as const, day: '2026-10-05' },
    { text: 'prefers short   exchanges.', kind: 'pref' as const, day: '2026-08-01' },
  ];

  it('keeps durable notes, newest first, without repeats', () => {
    expect(selectPersonNotes(entries, 500)).toEqual([
      'Is travelling to Valencia in May.',
      'Prefers short exchanges.',
    ]);
  });

  it('stays inside its budget', () => {
    expect(selectPersonNotes(entries, 40)).toEqual(['Is travelling to Valencia in May.']);
    expect(selectPersonNotes(entries, 10)).toEqual([]);
  });

  it('sits in the stable prompt after lessons, and only when there is something to say', () => {
    expect(renderPersonNotesBlock([])).toBe('');
    const built = buildInstructions({
      name: 'Wren',
      role: 'Tutor',
      about: 'You teach Spanish.',
      lessons: '- Correct one thing at a time.',
      personNotes: ['Is called Sam.', 'Is travelling to Valencia in May.'],
      project: { id: 'spanish', name: 'Spanish', about: 'Daily practice.' } as never,
      layeredPrefixCache: true,
    });
    expect(built.layers?.gezel).toContain('### About the person');
    expect(built.layers?.gezel).toContain('- Is travelling to Valencia in May.');
    expect(built.full.indexOf('### About the person')).toBeGreaterThan(
      built.full.indexOf('### Lessons from past work'),
    );
    expect(built.sections.find((s) => s.name === 'aboutPerson')?.band).toBe('stable');

    const minimal = buildInstructions({
      name: 'Wren',
      role: 'Tutor',
      about: 'You teach Spanish.',
      personNotes: ['Is called Sam.'],
      minimalContext: true,
    });
    expect(minimal.full).toContain('- Is called Sam.');
  });
});
