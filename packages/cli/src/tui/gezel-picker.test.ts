import type { GezelSummary } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  CORE_ROLE_ORDER,
  type GezelTemplateChoice,
  buildGezelPickerItems,
  resolveGezelArg,
} from './gezel-picker.js';

function gezel(partial: Partial<GezelSummary> & { id: string; name: string }): GezelSummary {
  return partial as GezelSummary;
}

const TEMPLATES: GezelTemplateChoice[] = [
  { id: 'voorman', name: 'Voorman', role: 'Voorman', description: 'Foreman of a project.' },
  { id: 'builder', name: 'Builder', role: 'Builder', description: 'Takes a job end-to-end.' },
  { id: 'developer', name: 'Developer', role: 'Developer', description: 'Writes and ships code.' },
  { id: 'reviewer', name: 'Reviewer', role: 'Reviewer', description: 'Second set of eyes.' },
  {
    id: 'boekwachter',
    name: 'Boekwachter',
    role: 'Boekwachter',
    description: 'The index-keeper. Works quietly in the background.',
  },
  {
    id: 'reisleider',
    name: 'Reisleider',
    role: 'Reisleider',
    description: 'A well-traveled guide who plans trips people actually take.',
  },
];

const BUILDER = gezel({ id: 'g1', name: 'Joris', role: 'Builder', templateId: 'builder' });
const KLERK = gezel({ id: 'g2', name: 'Nel', role: 'Klerk' });

function sectionsOf(items: ReturnType<typeof buildGezelPickerItems>): string[] {
  return [...new Set(items.map((item) => item.section ?? ''))];
}

describe('buildGezelPickerItems', () => {
  it('explains every role, including the Dutch-named ones', () => {
    const items = buildGezelPickerItems({
      gezels: [],
      templates: TEMPLATES,
      memberIds: [],
    });
    const boekwachter = items.find((item) => item.value === 'template:boekwachter');
    expect(boekwachter?.label).toBe('Boekwachter');
    expect(boekwachter?.hint).toContain('index-keeper');
  });

  it('puts project members first and offers the rest of the gilde after', () => {
    const items = buildGezelPickerItems({
      gezels: [BUILDER, KLERK],
      templates: TEMPLATES,
      memberIds: ['g1'],
    });
    expect(sectionsOf(items)).toEqual([
      'In this project',
      'Your other gezels',
      'Core roles',
      'More roles',
    ]);
    expect(items[0]?.value).toBe('gezel:g1');
  });

  it('orders unfilled roles by centrality, voorman first', () => {
    const items = buildGezelPickerItems({
      gezels: [],
      templates: TEMPLATES,
      memberIds: [],
    });
    const core = items.filter((item) => item.section === 'Core roles').map((item) => item.value);
    expect(core).toEqual([
      'template:voorman',
      'template:builder',
      'template:developer',
      'template:reviewer',
    ]);
    // Roles with no centrality ranking fall to the tail, alphabetically.
    const more = items.filter((item) => item.section === 'More roles').map((item) => item.value);
    expect(more).toEqual(['template:boekwachter', 'template:reisleider']);
  });

  it('drops a role the project has already filled', () => {
    const items = buildGezelPickerItems({
      gezels: [BUILDER],
      templates: TEMPLATES,
      memberIds: ['g1'],
    });
    expect(items.map((item) => item.value)).not.toContain('template:builder');
  });

  it('leads with the roles the detected project type calls for, and says why', () => {
    const items = buildGezelPickerItems({
      gezels: [],
      templates: TEMPLATES,
      memberIds: [],
      project: { detectedProjectType: { id: 'browser-game' } },
    });
    const recommended = items.filter((item) => item.section === 'Recommended for this project');
    expect(recommended.length).toBeGreaterThan(0);
    expect(items[0]?.section).toBe('Recommended for this project');
    // The hint is the taxonomy's per-type reason, not the generic template
    // description — that is the whole point of surfacing affinity here.
    expect(recommended[0]?.hint).toBeTruthy();
    expect(recommended[0]?.hint).not.toBe('Writes and ships code.');
  });

  it('falls back to plain core ordering when nothing detected the project type', () => {
    const items = buildGezelPickerItems({
      gezels: [],
      templates: TEMPLATES,
      memberIds: [],
      project: {},
    });
    expect(sectionsOf(items)).not.toContain('Recommended for this project');
  });

  it('clips hints to the terminal width', () => {
    const items = buildGezelPickerItems({
      gezels: [],
      templates: TEMPLATES,
      memberIds: [],
      hintWidth: 20,
    });
    for (const item of items) expect((item.hint ?? '').length).toBeLessThanOrEqual(20);
  });

  it('keeps every core role id reachable from the catalog ordering', () => {
    // Guards against a rename in the gilde silently dropping a role out of the
    // core section and into the alphabetical tail.
    expect(new Set(CORE_ROLE_ORDER).size).toBe(CORE_ROLE_ORDER.length);
  });
});

describe('resolveGezelArg', () => {
  const inputs = { gezels: [BUILDER, KLERK], templates: TEMPLATES };

  it('matches an existing gezel by given name', () => {
    expect(resolveGezelArg('Joris', inputs)).toEqual({ kind: 'gezel', gezelId: 'g1' });
  });

  it('matches an existing gezel by role rather than recruiting a second one', () => {
    expect(resolveGezelArg('builder', inputs)).toEqual({ kind: 'gezel', gezelId: 'g1' });
  });

  it('resolves an unfilled role to the template to recruit', () => {
    expect(resolveGezelArg('voorman', inputs)).toEqual({ kind: 'template', templateId: 'voorman' });
  });

  it('is case-insensitive', () => {
    expect(resolveGezelArg('VOORMAN', inputs)).toEqual({ kind: 'template', templateId: 'voorman' });
  });

  it('accepts a unique prefix', () => {
    expect(resolveGezelArg('reisl', inputs)).toEqual({
      kind: 'template',
      templateId: 'reisleider',
    });
  });

  it('reports the candidates instead of guessing on an ambiguous prefix', () => {
    const resolved = resolveGezelArg('re', inputs);
    expect(resolved.kind).toBe('ambiguous');
    expect(resolved).toMatchObject({ labels: ['Reviewer', 'Reisleider'] });
  });

  it('reports unknown for a role nobody has', () => {
    expect(resolveGezelArg('astronaut', inputs)).toEqual({ kind: 'unknown' });
  });

  it('treats an empty argument as unknown', () => {
    expect(resolveGezelArg('   ', inputs)).toEqual({ kind: 'unknown' });
  });
});
