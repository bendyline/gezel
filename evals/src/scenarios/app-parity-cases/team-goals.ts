import { isoDaysAhead, records } from '../app-parity-helpers.ts';
import type { ParityCase } from '../app-parity.ts';

const QUARTER_START = isoDaysAhead(-33);
const goal = (title: string, owner: string, dueAt: string) => ({
  tool: 'page_add_goal',
  input: { title, owner, startAt: QUARTER_START, dueAt },
});
const keyResult = (
  goalTitle: string,
  title: string,
  current: number,
  target: number,
  unit?: string,
) => ({
  tool: 'page_add_key_result',
  input: { goal: goalTitle, title, start: 0, current, target, ...(unit ? { unit } : {}) },
});
// Fernwood Studio's demo board: retainers on track, case studies at risk, the website behind.
const BOARD = [
  goal('Win four new retainer clients', 'Theo', isoDaysAhead(59)),
  keyResult('Win four new retainer clients', 'New retainer clients', 1, 4, 'clients'),
  keyResult('Win four new retainer clients', 'Proposals sent', 5, 10, 'proposals'),
  goal('Publish three case studies', 'Mara', isoDaysAhead(59)),
  keyResult('Publish three case studies', 'Case studies published', 0, 3),
  keyResult('Publish three case studies', 'Client sign-offs collected', 1, 3),
  goal('Launch the new studio website', 'Jonah', isoDaysAhead(28)),
  keyResult('Launch the new studio website', 'Pages designed', 3, 8, 'pages'),
  keyResult('Launch the new studio website', 'Pages built', 0, 8, 'pages'),
];

const current = (docs: Record<string, unknown>, title: string) =>
  records(docs['keyresults.json']).find((r) => String(r.fields?.title) === title)?.fields?.current;

const cases: ParityCase[] = [
  {
    id: 'team-goals-two-more-clients',
    typeId: 'team-goals',
    params: { team: 'a six-person design studio' },
    prepare: BOARD,
    message: 'We signed two more retainer clients',
    reads: ['keyresults.json'],
    check: (docs) => {
      const clients = current(docs, 'New retainer clients');
      const proposals = current(docs, 'Proposals sent');
      return clients === 3 && proposals === 5
        ? { ok: true, detail: 'New retainer clients moved from 1 to 3; Proposals sent untouched' }
        : { ok: false, detail: `clients=${String(clients)} proposals=${String(proposals)}` };
    },
  },
  {
    id: 'team-goals-furthest-behind',
    typeId: 'team-goals',
    params: { team: 'a six-person design studio' },
    prepare: BOARD,
    message: 'Which goal is furthest behind?',
    reads: [],
    check: () => ({ ok: true, detail: 'a question changes no file' }),
    reply: (text) => {
      // The board sorts it first: 19% done with 54% of its time gone.
      const website = /website/i.test(text);
      return website
        ? { ok: true, detail: 'named the website goal as furthest behind' }
        : { ok: false, detail: 'did not name the website goal' };
    },
  },
];

export default cases;
