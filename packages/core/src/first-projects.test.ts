import { describe, expect, it } from 'vitest';
import { FIRST_PROJECTS, type FirstProject, firstProjectsFor } from './first-projects.js';
import { PromptMeesterBuildPrelude } from './model-profile/behaviors/prompt-meester-build-prelude.js';
import { PromptMeesterCraftbookPrelude } from './model-profile/behaviors/prompt-meester-craftbook-prelude.js';
import type { TurnCtx } from './model-profile/types.js';

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

// A typed first project reaches its project type only through the meester's
// start_project, and on a small model that call reliably happens only under
// the build prelude. Unprompted, Gemma 4 E4B answered "a week of meals" and
// "a word game" in chat, or recruited a gezel of its own (2026-10-14).
describe('typed first projects and the meester', () => {
  const turn = (userText: string): TurnCtx => ({
    catalogId: 'gemma4-e4b-q4',
    tier: 'small',
    family: 'gemma',
    modelId: 'gemma4-e4b-q4',
    providerName: 'llama-cpp',
    sessionId: 'welcome',
    isMeester: true,
    projectId: 'default',
    messageOrigin: 'direct-user',
    availableToolNames: ['start_project', 'invoke_craftbook', 'suggest_craftbook'],
    userText,
    drained: [],
    assistantContent: '',
    continuationCount: 0,
  });

  it('words every one so the meester is steered to start its project, and only that', () => {
    for (const first of FIRST_PROJECTS) {
      if (first.kind !== 'type') continue;
      const ctx = turn(first.prompt);
      expect(PromptMeesterBuildPrelude.userPromptPrelude!(ctx, undefined), first.id).toContain(
        'start_project',
      );
      expect(PromptMeesterCraftbookPrelude.userPromptPrelude!(ctx, undefined), first.id).toBeNull();
    }
  });
});
