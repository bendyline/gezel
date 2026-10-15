import type { InterestAreaId } from './interests/areas.js';

/**
 * The first projects the meester's welcome offers.
 *
 * Two kinds. A typed first project is a goal a project type carries end to
 * end with one lead and its own tools, finishing on a board the person can
 * open: on a 12B on-device model a family trip went from the ask to a ten-day
 * itinerary on the trip board in well under a minute. A craftbook first
 * project launches a book straight from the composer (the attached-task
 * route, no meester turn); it serves the areas no project type covers, such
 * as Work and Data, and may bring a sample to work on so it needs nothing
 * from the person to start.
 *
 * An entry belongs here once it passes its evals: 2 of 3 runs on Gemma 4 E4B
 * and 3 of 3 on Gemma 4 12B in the default Lockdown posture, because the
 * first request is the wrong place to find out. The entries below the
 * marker in the list were promoted ahead of that so every interest area has
 * starts of its own; any that fail the `first-projects` suite come out.
 *
 * A card prefills its sentence into the composer rather than sending it, so
 * the person makes it theirs ("Lisbon" becomes "Kyoto") before anyone reads
 * it. The catalog package's data-contract test holds each `typeId` to its
 * routing and each `craftbookId` and sample to the pinned catalog, so a
 * renamed type or a removed book fails there, not on a first run.
 */
interface FirstProjectBase {
  id: string;
  /** The interest area the welcome files it under. */
  area: InterestAreaId;
  title: string;
  /** What the person ends up with, in a line. */
  hint: string;
  /** The editable sentence the card puts in the composer. */
  prompt: string;
  /**
   * Passed on a phone's own model in the phone runtime (2 of 3 runs). A phone
   * offers only these; the desktop offers every entry.
   */
  phone?: boolean;
}

export interface TypedFirstProject extends FirstProjectBase {
  kind: 'type';
  /** The project type the sentence must route to. */
  typeId: string;
}

export interface CraftbookFirstProject extends FirstProjectBase {
  kind: 'craftbook';
  craftbookId: string;
  /** A sample the book carries, used when the person brings nothing of their own. */
  sample?: { param: string; sampleId: string };
}

export type FirstProject = TypedFirstProject | CraftbookFirstProject;

export const FIRST_PROJECTS: readonly FirstProject[] = [
  {
    kind: 'type',
    id: 'trip',
    area: 'home',
    title: 'Plan a trip',
    hint: 'A day-by-day plan and a packing list, on a trip board.',
    prompt:
      'Plan a trip to Lisbon next spring for the four of us, about a week, with a packing list.',
    typeId: 'trip-planner',
    // Shipped on the phone before the phone bar existed; the phone column
    // of the eval tracker is what confirms or removes it.
    phone: true,
  },
  {
    kind: 'type',
    id: 'language',
    area: 'learning',
    title: 'Practice a language',
    hint: 'Short role-play scenes with a patient tutor.',
    prompt: 'Start a project to practice Spanish with a language tutor. I know the basics.',
    typeId: 'language-trainer',
    phone: true,
  },
  {
    kind: 'craftbook',
    id: 'notes-to-actions',
    area: 'work',
    title: 'Turn meeting notes into actions',
    hint: 'Who does what by when, from a meeting’s notes.',
    prompt: 'Turn these meeting notes into a list of who does what by when.',
    craftbookId: 'meeting-notes-to-actions',
    sample: { param: 'source', sampleId: 'team-sync' },
  },
  {
    kind: 'craftbook',
    id: 'spreadsheet',
    area: 'data',
    title: 'Make sense of a spreadsheet',
    hint: 'What is in it, what stands out, and what to look at next.',
    prompt: 'Tell me what stands out in this spreadsheet.',
    craftbookId: 'spreadsheet-findings',
    sample: { param: 'source', sampleId: 'shop-sales' },
  },
  {
    kind: 'craftbook',
    id: 'tidy',
    area: 'data',
    title: 'Tidy up a spreadsheet',
    hint: 'A clean copy, and a list of what was changed.',
    prompt: 'Tidy up this spreadsheet.',
    craftbookId: 'tidy-spreadsheet',
    sample: { param: 'source', sampleId: 'club-members' },
  },
  {
    kind: 'craftbook',
    id: 'explain-code',
    area: 'software',
    title: 'Explain a code folder',
    hint: 'What it does, how it is laid out, and where to start reading.',
    prompt: 'Explain how this code folder works.',
    craftbookId: 'explain-code-folder',
    sample: { param: 'source', sampleId: 'todo-cli' },
  },
  {
    kind: 'craftbook',
    id: 'review-code',
    area: 'software',
    title: 'Review a code folder',
    hint: 'Findings with the file and line, and what is good.',
    prompt: "Review this code and tell me what's wrong.",
    craftbookId: 'review-code-folder',
    sample: { param: 'source', sampleId: 'todo-cli-bugs' },
  },
  // Promoted 2026-10-14 ahead of their `first-project-*` evals. Kept after
  // the evaluated entries so those stay first in their own areas. Celebration,
  // meals, flashcards and interview came out on 2026-10-14: each missed the
  // bar (the party left its budget empty on 12B; the others routed elsewhere
  // or left a thin board on E4B).
  {
    kind: 'craftbook',
    id: 'status-report',
    area: 'work',
    title: 'Write a status report',
    hint: 'A short update your team can read in a minute.',
    prompt:
      'Write a status report for my team: we shipped the new onboarding flow, the billing migration slipped a week, and hiring is on track.',
    craftbookId: 'status-report',
  },
  {
    kind: 'craftbook',
    id: 'proposal',
    area: 'business',
    title: 'Draft a proposal',
    hint: 'Scope, timeline and price, ready to send.',
    prompt: "Draft a proposal for redesigning a local bakery's website, about four weeks of work.",
    craftbookId: 'proposal-sow',
  },
  {
    kind: 'craftbook',
    id: 'newsletter',
    area: 'content',
    title: 'Write a newsletter issue',
    hint: 'This month’s news, written to be read.',
    prompt:
      "Write this month's newsletter for my pottery studio: a new glaze, a spring class, and a studio sale.",
    craftbookId: 'newsletter-issue',
  },
  {
    kind: 'type',
    id: 'invoice',
    area: 'business',
    title: 'Send an invoice',
    hint: 'Your clients and what they owe, on an office board.',
    prompt:
      "Start a project to run my freelance office. I'm an illustrator, and two clients owe me: Harbor Books $1,200 for a book cover and Riverside Cafe $450 for a menu, both due at the end of the month.",
    typeId: 'freelance-office',
  },
  {
    kind: 'type',
    id: 'posts',
    area: 'content',
    title: 'Plan a week of posts',
    hint: 'Drafts in your voice, ready to publish.',
    prompt: 'Start a project to plan a week of LinkedIn posts for my pottery studio.',
    typeId: 'social-feed',
  },
  {
    kind: 'type',
    id: 'word-clues',
    area: 'play',
    title: 'Play a word game',
    hint: 'Clues to solve, one word at a time.',
    prompt: "Start a project to play a word game: give me clues and I'll guess the words.",
    typeId: 'word-clues',
  },
];

/**
 * The areas the default spread draws from when the person chose nothing, in
 * order. Work, Data, Home and Learning first, so the welcome's face is four
 * different kinds of work rather than two parties and a tutor.
 */
export const DEFAULT_FIRST_PROJECT_AREAS: readonly InterestAreaId[] = [
  'work',
  'data',
  'home',
  'learning',
  'business',
  'content',
  'software',
  'play',
];

/** How many first projects the welcome offers. */
export const FIRST_PROJECT_COUNT = 4;

/** A chosen area gives at most this many, so a single pick still shows the range. */
const PER_CHOSEN_AREA = 2;

/**
 * The first projects to offer, in order: the person's areas first (round-robin
 * in the order they picked them, at most two each), then one from each other
 * area in the default spread, then whatever the pool has left. A host that
 * cannot run craftbook tasks never sees a craftbook first project.
 */
export function firstProjectsFor(opts: {
  interests: readonly InterestAreaId[];
  canRunCraftbooks: boolean;
  /** A phone offers only entries that passed on the phone. */
  host?: 'desktop' | 'phone';
  count?: number;
  pool?: readonly FirstProject[];
}): FirstProject[] {
  const count = opts.count ?? FIRST_PROJECT_COUNT;
  const eligible = (opts.pool ?? FIRST_PROJECTS).filter(
    (p) =>
      (p.kind === 'type' || opts.canRunCraftbooks) && (opts.host !== 'phone' || p.phone === true),
  );
  const picked: FirstProject[] = [];
  const take = (p: FirstProject | undefined): void => {
    if (p && picked.length < count && !picked.includes(p)) picked.push(p);
  };
  const nextIn = (area: InterestAreaId): FirstProject | undefined =>
    eligible.find((p) => p.area === area && !picked.includes(p));

  for (let round = 0; round < PER_CHOSEN_AREA; round++) {
    for (const area of opts.interests) take(nextIn(area));
  }
  const given = new Set(picked.map((p) => p.area));
  for (const area of DEFAULT_FIRST_PROJECT_AREAS) {
    if (!given.has(area)) take(nextIn(area));
  }
  for (const p of eligible) take(p);
  return picked;
}
