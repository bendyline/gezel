import { describe, expect, it } from 'vitest';
import { type FirstProject, firstProjectsFor } from './first-projects.js';

const typed = (id: string, area: FirstProject['area']): FirstProject => ({
  kind: 'type',
  id,
  area,
  title: id,
  hint: id,
  prompt: id,
  typeId: id,
});
const book = (id: string, area: FirstProject['area']): FirstProject => ({
  kind: 'craftbook',
  id,
  area,
  title: id,
  hint: id,
  prompt: id,
  craftbookId: id,
});

const POOL: FirstProject[] = [
  typed('trip', 'home'),
  typed('celebration', 'home'),
  typed('meals', 'home'),
  typed('language', 'learning'),
  book('notes', 'work'),
  book('sheet', 'data'),
  typed('chess', 'play'),
];
const ids = (list: FirstProject[]) => list.map((p) => p.id);

describe('firstProjectsFor', () => {
  it('spreads across areas when nothing is chosen, Work and Data first', () => {
    expect(ids(firstProjectsFor({ interests: [], canRunCraftbooks: true, pool: POOL }))).toEqual([
      'notes',
      'sheet',
      'trip',
      'language',
    ]);
  });

  it('puts chosen areas first, two at most each, then the spread', () => {
    expect(
      ids(firstProjectsFor({ interests: ['home'], canRunCraftbooks: true, pool: POOL })),
    ).toEqual(['trip', 'celebration', 'notes', 'sheet']);
    expect(
      ids(firstProjectsFor({ interests: ['play', 'home'], canRunCraftbooks: true, pool: POOL })),
    ).toEqual(['chess', 'trip', 'celebration', 'notes']);
  });

  it('leaves craftbook first projects off a host that cannot run them', () => {
    expect(
      ids(firstProjectsFor({ interests: ['work'], canRunCraftbooks: false, pool: POOL })),
    ).toEqual(['trip', 'language', 'chess', 'celebration']);
  });

  it('never repeats an entry and stops at the count', () => {
    const list = firstProjectsFor({
      interests: ['home', 'home'],
      canRunCraftbooks: true,
      pool: POOL,
      count: 2,
    });
    expect(ids(list)).toEqual(['trip', 'celebration']);
  });
});

describe('firstProjectsFor on a phone', () => {
  it('offers only what passed on the phone', () => {
    const pool: FirstProject[] = [
      { ...typed('trip', 'home'), phone: true },
      typed('meals', 'home'),
      { ...typed('chess', 'play'), phone: true },
    ];
    expect(
      firstProjectsFor({ interests: [], canRunCraftbooks: true, host: 'phone', pool }).map(
        (p) => p.id,
      ),
    ).toEqual(['trip', 'chess']);
  });
});
