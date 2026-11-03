import { isoDaysAhead, records } from '../app-parity-helpers.ts';
import type { ParityCase } from '../app-parity.ts';

const DESK = [
  {
    tool: 'page_add_role',
    input: {
      title: 'Barista',
      requirements:
        'Coffee and milk skills, Warm customer service, Reliability and teamwork, Weekend availability',
      openings: 2,
      manager: 'Dana',
    },
  },
  {
    tool: 'page_add_candidate',
    input: { name: 'Ana Ruiz', role: 'Barista', source: 'Job board', status: 'screen' },
  },
  {
    tool: 'page_add_candidate',
    input: {
      name: 'Theo Brandt',
      role: 'Barista',
      source: 'Referral',
      interviewOn: isoDaysAhead(2),
      interviewTime: '10:00 am',
      interviewer: 'Dana',
    },
  },
  {
    tool: 'page_add_candidate',
    input: { name: 'Jordan Price', role: 'Barista', source: 'Walk-in' },
  },
];

const cases: ParityCase[] = [
  {
    id: 'hiring-desk-book-interview',
    typeId: 'hiring-desk',
    params: { business: 'a café in Portland' },
    prepare: DESK,
    message: 'Move Ana to interview; book Thursday',
    reads: ['candidates.json'],
    check: (docs) => {
      const ana = records(docs['candidates.json']).filter((r) =>
        /ana ruiz/i.test(String(r.fields?.name)),
      );
      if (ana.length !== 1) return { ok: false, detail: `${ana.length} Ana Ruiz records` };
      const day = String(ana[0]!.fields?.interviewAt ?? '');
      const thursday =
        /^\d{4}-\d{2}-\d{2}$/.test(day) &&
        new Date(`${day}T12:00:00`).getDay() === 4 &&
        day >= isoDaysAhead(0) &&
        day <= isoDaysAhead(7);
      return ana[0]!.status === 'interview' && thursday
        ? { ok: true, detail: `Ana at interview on ${day}` }
        : { ok: false, detail: `status=${String(ana[0]!.status)} interviewAt=${day || 'none'}` };
    },
  },
  {
    id: 'hiring-desk-whos-interviewing',
    typeId: 'hiring-desk',
    params: { business: 'a café in Portland' },
    prepare: DESK,
    message: 'Who’s interviewing this week?',
    reads: [],
    check: () => ({ ok: true, detail: 'a question changes no file' }),
    reply: (text) => {
      const theo = /theo/i.test(text);
      const notYet =
        /screen|sourced|not (yet )?(booked|scheduled)|no interview|hasn.t|isn.t|yet to/i;
      const strays = /\b(ana|jordan)\b/i.test(text) && !notYet.test(text);
      return theo && !strays
        ? { ok: true, detail: 'named Theo and did not book anyone else' }
        : { ok: false, detail: `theo=${theo} strayCandidate=${strays}` };
    },
  },
];

export default cases;
