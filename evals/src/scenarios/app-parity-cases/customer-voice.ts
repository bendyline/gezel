import { isoDaysAhead, list, records } from '../app-parity-helpers.ts';
import type { ParityCase } from '../app-parity.ts';

const log = (
  text: string,
  source: string,
  stars: string,
  days: number,
  themes?: string,
  author?: string,
) => ({
  tool: 'page_log_feedback',
  input: {
    text,
    source,
    stars,
    receivedAt: isoDaysAhead(-days),
    ...(themes ? { themes } : {}),
    ...(author ? { author } : {}),
  },
});

const VOICE = [
  log(
    'Waited 20 minutes for a latte on Saturday morning.',
    'survey',
    '3',
    47,
    'Slow weekend service',
  ),
  log(
    'Forty minutes for two breakfast sandwiches on Sunday. Food was good once it came.',
    'yelp',
    '2',
    17,
    'Slow weekend service',
    'Carla M.',
  ),
  log('Luis made my day, so friendly.', 'google', '5', 9, 'Friendly staff', 'Tom H.'),
  log(
    'Charging extra for oat milk feels steep for a five-dollar latte.',
    'google',
    '3',
    6,
    'Oat milk charge',
    'Nadia R.',
  ),
  log(
    'Weekend wait is too long; I left without ordering.',
    'survey',
    '2',
    4,
    'Slow weekend service',
  ),
  log(
    'Waited 25 minutes on Saturday and my cappuccino was cold.',
    'google',
    '1',
    2,
    undefined,
    'Sam D.',
  ),
  log('The new window seats are perfect for reading.', 'survey', '5', 1),
  {
    tool: 'page_add_action',
    input: {
      title: 'Add a second barista on weekend mornings',
      theme: 'Slow weekend service',
      owner: 'Dana',
    },
  },
  {
    tool: 'page_set_action_status',
    input: { title: 'Add a second barista on weekend mornings', status: 'doing' },
  },
];

/** The feedback log folded the way the voice-store script folds it: each entry with its latest themes. */
function entries(doc: unknown): Array<{ id: string; text: string; themes: string[] }> {
  const out = new Map<string, { id: string; text: string; themes: string[] }>();
  for (const event of list(doc, 'events')) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (
      /^(review|survey|comment)$/.test(String(event.kind)) &&
      typeof data.id === 'string' &&
      !out.has(data.id)
    ) {
      out.set(data.id, {
        id: data.id,
        text: String(event.note ?? ''),
        themes: Array.isArray(data.themes) ? (data.themes as string[]) : [],
      });
    }
    const target = out.get(String(data.feedbackId));
    if (
      target &&
      (event.kind === 'tagged' || (event.kind === 'edited' && Array.isArray(data.themes)))
    ) {
      target.themes = data.themes as string[];
    }
  }
  return [...out.values()];
}

const cases: ParityCase[] = [
  {
    id: 'customer-voice-sort-new',
    typeId: 'customer-voice',
    params: {
      business: 'a café in Portland',
      sources: 'Google and Yelp reviews and a receipt survey',
    },
    prepare: VOICE,
    message: 'Sort the new reviews into themes',
    reads: ['feedback.json', 'themes.json'],
    check: (docs) => {
      const all = entries(docs['feedback.json']);
      const names = new Map(
        records(docs['themes.json']).map((t) => [String(t.id), String(t.fields?.name)]),
      );
      const unsorted = all.filter((e) => !e.themes.length);
      const cold = all.find((e) => /cappuccino was cold/i.test(e.text));
      const coldThemes = (cold?.themes ?? []).map((id) => names.get(id) ?? id);
      const wait = coldThemes.some((name) => /slow|wait|service/i.test(name));
      return all.length === 7 && !unsorted.length && wait
        ? {
            ok: true,
            detail: `all 7 sorted; the cold cappuccino is under ${coldThemes.join(', ')}`,
          }
        : {
            ok: false,
            detail: `entries=${all.length} unsorted=${unsorted.map((e) => e.id).join(',') || 'none'} coldThemes=${coldThemes.join(',') || 'none'}`,
          };
    },
  },
  {
    id: 'customer-voice-this-month',
    typeId: 'customer-voice',
    params: {
      business: 'a café in Portland',
      sources: 'Google and Yelp reviews and a receipt survey',
    },
    prepare: VOICE,
    message: 'What are customers saying this month?',
    reads: [],
    check: () => ({ ok: true, detail: 'a question changes no file' }),
    reply: (text) => {
      // The weekend wait leads the month; a summary also names at least one other theme.
      const wait = /slow|wait/i.test(text);
      const other = /oat milk|friendly|staff/i.test(text);
      return wait && other
        ? { ok: true, detail: 'led with the weekend wait and named another theme' }
        : { ok: false, detail: `wait=${wait} otherTheme=${other}` };
    },
  },
];

export default cases;
