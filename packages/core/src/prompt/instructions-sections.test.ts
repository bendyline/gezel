import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../retrieval-budget.js';
import type { ProjectDetail } from '../schemas/project.js';
import { type BuildInstructionsOptions, buildInstructions } from './instructions.js';

const base = {
  name: 'Wren',
  role: 'Tutor',
  about: 'You teach Spanish through short conversations.',
  project: { id: 'spanish', name: 'Spanish', about: 'Daily practice.' } as ProjectDetail,
  availableTools: [{ name: 'read_file', description: 'Read a file.' }],
} satisfies BuildInstructionsOptions;

const task = {
  task: {
    ref: 'spanish/3',
    title: 'Weekly review',
    status: 'active',
    assignee: { kind: 'gezel', gezelId: 'wren' },
    activeStepId: 'review',
    craftbook: {
      steps: [{ id: 'review', name: 'Review', prompt: 'Review the week with `read_file`.' }],
      entryStepId: 'review',
    },
  },
  step: { id: 'review', name: 'Review', prompt: 'Review the week with `read_file`.' },
} as unknown as BuildInstructionsOptions['task'];

function sized(opts: BuildInstructionsOptions) {
  const built = buildInstructions(opts);
  const names = built.sections.map((s) => s.name);
  const total = built.sections.reduce((n, s) => n + s.tokens, 0);
  const text = [built.full, built.volatileContext ?? ''].join('');
  return { built, names, total, text };
}

describe('buildInstructions section sizes', () => {
  it('sizes the standard prompt in order, leaving empty sections out', () => {
    const { built, names, total, text } = sized(base);
    expect(names[0]).toBe('header');
    expect(names).toContain('about (persona body)');
    expect(names).toContain('availableTools (text block)');
    expect(built.sections.every((s) => s.tokens > 0)).toBe(true);
    // Separators are not a section, so the parts come to a little under the whole.
    expect(total).toBeLessThanOrEqual(estimateTokens(text));
    expect(total).toBeGreaterThan(estimateTokens(text) * 0.9);
  });

  it('marks session context volatile under the layered cache', () => {
    const { built } = sized({ ...base, layeredPrefixCache: true, task });
    const taskSection = built.sections.find((s) => s.name === 'taskContext');
    expect(taskSection?.band).toBe('volatile');
    expect(built.sections.find((s) => s.name === 'header')?.band).toBe('stable');
  });

  it('sizes the minimal prompt', () => {
    const { built, names } = sized({ ...base, minimalContext: true });
    expect(names).toEqual(['header', 'aboutIntro', 'about (persona body)', 'minimalConduct']);
    expect(built.sections.reduce((n, s) => n + s.tokens, 0)).toBeGreaterThan(0);
  });

  it('sizes the focused step prompt', () => {
    const { names } = sized({ ...base, focusedTaskContext: true, task });
    expect(names).toContain('focusedStepIntro');
    expect(names).toContain('taskContext');
    expect(names).not.toContain('about (persona body)');
  });
});
