import { isoDaysAhead, records } from '../app-parity-helpers.ts';
import type { ParityCase } from '../app-parity.ts';

const PLANS = [
  {
    tool: 'page_add_hire',
    input: {
      name: 'Mira Okafor',
      role: 'Barista',
      startOn: isoDaysAhead(4),
      manager: 'Dana',
      buddy: 'Hana Sato',
    },
  },
  { tool: 'page_complete_task', input: { hire: 'Mira Okafor', task: 'welcome note' } },
  {
    tool: 'page_add_hire',
    input: { name: 'Jamal Reed', role: 'Line cook', startOn: isoDaysAhead(-12), manager: 'Luis' },
  },
  { tool: 'page_complete_task', input: { hire: 'Jamal Reed', phase: 'before day one' } },
  { tool: 'page_complete_task', input: { hire: 'Jamal Reed', phase: 'day one' } },
  {
    tool: 'page_complete_task',
    input: { hire: 'Jamal Reed', task: 'Shadow shifts, Enroll in the training' },
  },
];

function step(docs: Record<string, unknown>, hire: RegExp, title: RegExp) {
  return records(docs['tasks.json']).find(
    (r) => hire.test(String(r.fields?.hireName)) && title.test(String(r.fields?.title)),
  );
}

const cases: ParityCase[] = [
  {
    id: 'new-hire-onboarding-accounts-ready',
    typeId: 'new-hire-onboarding',
    params: { business: 'a café with 12 staff' },
    prepare: PLANS,
    message: 'Mira’s email and scheduling accounts are set up',
    reads: ['tasks.json'],
    check: (docs) => {
      const accounts = step(docs, /mira/i, /accounts/i);
      const uniform = step(docs, /mira/i, /uniform/i);
      const checkIn = step(docs, /jamal/i, /first-week check-in/i);
      if (!accounts || !uniform || !checkIn) return { ok: false, detail: 'a plan step is missing' };
      return accounts.status === 'done' && uniform.status === 'todo' && checkIn.status === 'todo'
        ? { ok: true, detail: 'accounts checked off, nothing else' }
        : {
            ok: false,
            detail: `accounts=${String(accounts.status)} uniform=${String(uniform.status)} jamalCheckIn=${String(checkIn.status)}`,
          };
    },
  },
  {
    id: 'new-hire-onboarding-whats-overdue',
    typeId: 'new-hire-onboarding',
    params: { business: 'a café with 12 staff' },
    prepare: PLANS,
    message: 'What’s overdue?',
    reads: [],
    check: () => ({ ok: true, detail: 'a question changes no file' }),
    reply: (text) => {
      const jamal = /jamal/i.test(text);
      const checkIn = /check-?\s?in/i.test(text);
      return jamal && checkIn
        ? { ok: true, detail: 'named Jamal’s first-week check-in' }
        : { ok: false, detail: `jamal=${jamal} checkIn=${checkIn}` };
    },
  },
];

export default cases;
