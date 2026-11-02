import { addMonths, isoDaysAhead, list, records } from '../app-parity-helpers.ts';
import type { ParityCase } from '../app-parity.ts';

/** A completion `days` from today minus one validity period, so it runs out `days` from now. */
function runsOutIn(person: string, course: string, days: number, months: number) {
  return {
    tool: 'page_record_completion',
    input: { person, course, completedAt: addMonths(isoDaysAhead(days), -months) },
  };
}

const TRACKER = [
  {
    tool: 'page_add_course',
    input: { title: 'Food handler card', validMonths: 36, requiredFor: 'everyone' },
  },
  {
    tool: 'page_add_course',
    input: { title: 'Food safety refresher', validMonths: 12, requiredFor: 'everyone' },
  },
  { tool: 'page_add_person', input: { name: 'Mira Okafor', role: 'Barista' } },
  { tool: 'page_add_person', input: { name: 'Luis Romero', role: 'Kitchen lead' } },
  { tool: 'page_add_person', input: { name: 'Hana Sato', role: 'Barista' } },
  { tool: 'page_add_person', input: { name: 'Dana Whitfield', role: 'Manager' } },
  runsOutIn('Luis Romero', 'Food safety refresher', 6, 12),
  runsOutIn('Hana Sato', 'Food safety refresher', 11, 12),
  runsOutIn('Dana Whitfield', 'Food safety refresher', 200, 12),
  runsOutIn('Luis Romero, Hana Sato, Dana Whitfield', 'Food handler card', 700, 36),
];

const cases: ParityCase[] = [
  {
    id: 'training-tracker-certificate',
    typeId: 'training-tracker',
    params: { business: 'a café with 12 staff' },
    prepare: TRACKER,
    message: 'Mira passed her food handler card today, certificate FH-48213',
    reads: ['people.json', 'courses.json', 'completions.json'],
    check: (docs) => {
      const mira = records(docs['people.json']).filter((r) => /mira/i.test(String(r.fields?.name)));
      const card = records(docs['courses.json']).find((r) =>
        /food handler/i.test(String(r.fields?.title)),
      );
      if (mira.length !== 1 || !card) {
        return { ok: false, detail: `${mira.length} Mira records, card=${Boolean(card)}` };
      }
      const done = list(docs['completions.json'], 'events').find((e) => {
        const data = (e.data ?? {}) as Record<string, unknown>;
        return e.kind === 'completed' && data.personId === mira[0]!.id && data.courseId === card.id;
      });
      if (!done) return { ok: false, detail: 'no food handler completion for Mira' };
      const data = done.data as Record<string, unknown>;
      const cert = /FH-48213/.test(JSON.stringify(done));
      const expires = data.expiresAt === addMonths(isoDaysAhead(0), 36);
      return cert && expires
        ? { ok: true, detail: `FH-48213 on file, valid until ${String(data.expiresAt)}` }
        : { ok: false, detail: `certificate=${cert} expiresAt=${String(data.expiresAt)}` };
    },
  },
  {
    id: 'training-tracker-refreshers-due',
    typeId: 'training-tracker',
    params: { business: 'a café with 12 staff' },
    prepare: TRACKER,
    message: 'Who needs food-safety refreshers this month?',
    reads: [],
    check: () => ({ ok: true, detail: 'a question changes no file' }),
    reply: (text) => {
      const luis = /luis/i.test(text);
      const hana = /hana/i.test(text);
      const strays =
        /dana/i.test(text) && !/current|not due|until|later|valid|fine|good/i.test(text);
      return luis && hana && !strays
        ? { ok: true, detail: 'named Luis and Hana, left Dana out' }
        : { ok: false, detail: `luis=${luis} hana=${hana} strayDana=${strays}` };
    },
  },
];

export default cases;
