import { FIRST_PROJECTS, type FirstProject } from '@bendyline/gezel';
import type { AcceptableRoute } from './classify.ts';

/**
 * The route probes for the suggest_work / start_work A/B: one message each to
 * the Meester, scored on the route it takes (kind and target), not on the
 * work that follows. Each lists every route its arm-A design also counts as
 * correct, so the baseline is never penalized for doing what it was built to.
 *
 * The verbatim welcome sentences are read from `FIRST_PROJECTS`, so a reword
 * there is the sentence these probes send. Every typed one gets a paraphrase
 * without "Start a project to…" — the case the current routing loses when a
 * person rewrites the card, and the one this experiment exists to measure.
 */

export type ProbeCategory =
  | 'typed'
  | 'typed-paraphrase'
  | 'craftbook'
  | 'exact'
  | 'new-project'
  | 'in-project'
  | 'self'
  | 'ask'
  | 'author'
  | 'existing-work';

export interface RouteProbeSeed {
  /** A project the message is sent in. Absent: the Default project. */
  project?: { name: string; about: string; files?: Record<string, string> };
  /** A deck task already in Default, for "how is it going". */
  runningDeckTask?: true;
  /** The docblocks toolset, which the exact PowerPoint route needs. */
  docblocks?: true;
}

export interface RouteProbe {
  id: string;
  category: ProbeCategory;
  prompt: string;
  acceptable: AcceptableRoute[];
  seed?: RouteProbeSeed;
  /**
   * Not used to set suggest_work's floors. The read-out reports these apart:
   * the calibrated probes measure the design at its tuned point, these
   * whether it generalizes.
   */
  heldOut?: true;
}

function welcome(id: string): FirstProject {
  const entry = FIRST_PROJECTS.find((p) => p.id === id);
  if (!entry) throw new Error(`no first project "${id}"`);
  return entry;
}

function typed(id: string, paraphrase: string): RouteProbe[] {
  const entry = welcome(id);
  if (entry.kind !== 'type') throw new Error(`first project "${id}" is not typed`);
  const acceptable: AcceptableRoute[] = [
    { kind: 'project-type', target: new RegExp(`^${entry.typeId}$`) },
  ];
  return [
    { id: `${id}`, category: 'typed', prompt: entry.prompt, acceptable },
    { id: `${id}-paraphrase`, category: 'typed-paraphrase', prompt: paraphrase, acceptable },
  ];
}

function craftbook(id: string): RouteProbe {
  const entry = welcome(id);
  if (entry.kind !== 'craftbook') throw new Error(`first project "${id}" is not a craftbook`);
  return {
    id,
    category: 'craftbook',
    prompt: entry.prompt,
    acceptable: [{ kind: 'craftbook', target: new RegExp(`^${entry.craftbookId}$`) }],
  };
}

const ANSWER: AcceptableRoute[] = [{ kind: 'answer' }, { kind: 'consult' }];

export const ROUTE_PROBES: readonly RouteProbe[] = [
  ...typed(
    'trip',
    "We're going to Kyoto for a week in April, the two of us. Can you help with a day-by-day trip plan and a packing list?",
  ),
  ...typed('language', "I'd like to practice my Spanish. I know the basics."),
  ...typed(
    'invoice',
    "I'm a freelance illustrator and two clients owe me: Harbor Books $1,200 for a book cover and Riverside Cafe $450 for a menu, both due at the end of the month. Help me keep track of them and send invoices.",
  ),
  ...typed('posts', 'Help me plan a week of LinkedIn posts for my pottery studio.'),
  ...typed('word-clues', "Let's play a word game: give me clues and I'll guess the words."),
  {
    id: 'meals',
    category: 'typed-paraphrase',
    prompt: 'Plan a week of meals for two adults and a toddler, mostly vegetarian.',
    acceptable: [{ kind: 'project-type', target: /^meal-planner$/ }],
  },
  craftbook('status-report'),
  craftbook('proposal'),
  craftbook('newsletter'),
  {
    id: 'pptx',
    category: 'exact',
    prompt: 'Can you create a PowerPoint about Alaska?',
    acceptable: [
      { kind: 'craftbook', target: /^(?:powerpoint-deck|content-deck|narrated-slideshow)$/ },
    ],
    seed: { docblocks: true },
  },
  {
    id: 'data-clean',
    category: 'craftbook',
    prompt:
      'Please clean up the raw customer spreadsheets in this project: normalize the emails and dates, dedupe the records, and produce one tidy consolidated customers file. The raw CSV exports are under data/raw/.',
    acceptable: [
      {
        kind: 'craftbook',
        target:
          /^(?:dataset-clean|csv-transformer|data-pipeline-etl|data-quality-audit|data-join-merge|tidy-spreadsheet|records?-[a-z-]+)$/,
      },
    ],
    seed: {
      project: {
        name: 'Customer List Cleanup',
        about: 'Consolidate two raw customer CSV exports into one clean, deduplicated file.',
        files: {
          'data/raw/customers_a.csv':
            'id,name,email,signup_date\nA-001,Alice Jansen,ALICE@example.com,03/12/2026\nA-002,Bram Peters,bram@example.com ,2026-01-19',
          'data/raw/customers_b.csv':
            'id,name,email,signup_date\nB-001,Alice Jansen,alice@example.com,2026-03-14\nB-002,Deniz Kaya,deniz@example.com,2026-02-02',
        },
      },
    },
  },
  {
    id: 'bakery-site',
    category: 'new-project',
    prompt: 'Build me a small website for my bakery.',
    acceptable: [{ kind: 'new-project' }, { kind: 'delegate', target: /^(?:developer|builder)$/ }],
  },
  {
    id: 'tic-tac-toe',
    category: 'new-project',
    prompt: 'Make a tic-tac-toe game I can play in the browser.',
    acceptable: [{ kind: 'new-project' }, { kind: 'delegate', target: /^(?:developer|builder)$/ }],
  },
  {
    id: 'about-page',
    category: 'in-project',
    prompt: 'Write the about-page copy.',
    acceptable: [{ kind: 'craftbook' }, { kind: 'task' }, { kind: 'delegate' }, { kind: 'answer' }],
    seed: {
      project: {
        name: 'Bakery site',
        about: "The website for Rosa's Bakery: a home page, a menu page and an about page.",
        files: {
          'index.html': "<!doctype html><title>Rosa's Bakery</title><h1>Rosa's Bakery</h1>",
          'about.html': '<!doctype html><title>About</title><h1>About us</h1><p>TODO</p>',
        },
      },
    },
  },
  {
    id: 'advice',
    category: 'self',
    prompt:
      'Quick question, no need to start anything: for a small single-user desktop app that stores a few thousand records, would you lean towards SQLite or Postgres, and why?',
    acceptable: ANSWER,
  },
  { id: 'arithmetic', category: 'self', prompt: "What's 17 × 23?", acceptable: ANSWER },
  { id: 'capabilities', category: 'self', prompt: 'What can you do?', acceptable: ANSWER },
  {
    id: 'vague',
    category: 'ask',
    prompt: 'Help me with my thing for work.',
    acceptable: [{ kind: 'ask' }, { kind: 'answer' }],
  },
  {
    id: 'onboarding-recipe',
    category: 'author',
    prompt: 'I need a reusable recipe for onboarding a new client every month.',
    acceptable: [{ kind: 'author' }, { kind: 'craftbook', target: /onboard|client|intake/ }],
  },
  {
    id: 'deck-status',
    category: 'existing-work',
    prompt: 'How is the deck going?',
    acceptable: [{ kind: 'answer' }, { kind: 'status' }],
    seed: { runningDeckTask: true },
  },
  // Held out: written after the floors were set, never scored against them.
  {
    id: 'rome-paraphrase',
    category: 'typed-paraphrase',
    prompt:
      'My family wants to spend five days in Rome this summer. Can you map out the days and what to pack?',
    acceptable: [{ kind: 'project-type', target: /^trip-planner$/ }],
    heldOut: true,
  },
  {
    id: 'french-paraphrase',
    category: 'typed-paraphrase',
    prompt: "Can you help me get better at French conversation? I'm a beginner.",
    acceptable: [{ kind: 'project-type', target: /^language-trainer$/ }],
    heldOut: true,
  },
  {
    id: 'dinners-paraphrase',
    category: 'typed-paraphrase',
    prompt: 'What should we eat this week? Two of us, no meat, cheap dinners please.',
    acceptable: [{ kind: 'project-type', target: /^meal-planner$/ }],
    heldOut: true,
  },
  {
    id: 'roastery-paraphrase',
    category: 'typed-paraphrase',
    prompt: 'I want to post on LinkedIn every day next week about my coffee roastery.',
    acceptable: [{ kind: 'project-type', target: /^social-feed$/ }],
    heldOut: true,
  },
  {
    id: 'board-report',
    category: 'craftbook',
    prompt:
      "Turn last quarter's sales numbers into a short report for the board: revenue up 12%, churn flat, two new enterprise customers.",
    acceptable: [{ kind: 'craftbook' }],
    heldOut: true,
  },
  {
    id: 'jazz-docx',
    category: 'exact',
    prompt: 'Make me a Word document summarizing the history of jazz.',
    acceptable: [{ kind: 'craftbook', target: /^research-to-document$/ }],
    heldOut: true,
  },
  {
    id: 'candle-store',
    category: 'new-project',
    prompt: 'Set up a simple online store page for my candle business.',
    acceptable: [{ kind: 'new-project' }, { kind: 'delegate', target: /^(?:developer|builder)$/ }],
    heldOut: true,
  },
  {
    id: 'python-or-js',
    category: 'self',
    prompt: 'Is it better to learn Python or JavaScript first?',
    acceptable: ANSWER,
    heldOut: true,
  },
];
