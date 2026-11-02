import { addMonths, isoDaysAhead, list, records } from '../app-parity-helpers.ts';
import type { ParityCase } from '../app-parity.ts';

const PERMIT_DUE = isoDaysAhead(12);
const REGISTER = [
  {
    tool: 'page_add_obligation',
    input: {
      title: 'Food service permit',
      category: 'permit',
      dueAt: PERMIT_DUE,
      recurs: 'yearly',
      owner: 'Dana',
      authority: 'County Health Department',
    },
  },
  {
    tool: 'page_add_obligation',
    input: {
      title: 'Fire extinguisher inspection',
      category: 'inspection',
      dueAt: isoDaysAhead(-5),
      recurs: 'yearly',
      owner: 'Luis',
    },
  },
  {
    tool: 'page_add_obligation',
    input: {
      title: 'Business license',
      category: 'license',
      dueAt: isoDaysAhead(140),
      recurs: 'yearly',
      owner: 'Priya',
    },
  },
];

const cases: ParityCase[] = [
  {
    id: 'compliance-register-renewed',
    typeId: 'compliance-register',
    params: { business: 'a café in Portland' },
    prepare: REGISTER,
    message: 'We renewed the food service permit, certificate FSP-23107',
    reads: ['obligations.json', 'evidence.json'],
    check: (docs) => {
      const permit = records(docs['obligations.json']).find((r) =>
        /food service permit/i.test(String(r.fields?.title)),
      );
      if (!permit) return { ok: false, detail: 'the permit left the register' };
      const proof = list(docs['evidence.json'], 'events').some((e) =>
        /FSP-23107/.test(JSON.stringify(e)),
      );
      const rolled = permit.fields?.dueAt === addMonths(PERMIT_DUE, 12);
      return proof && rolled
        ? {
            ok: true,
            detail: `permit rolled to ${String(permit.fields?.dueAt)} with FSP-23107 on file`,
          }
        : { ok: false, detail: `dueAt=${String(permit.fields?.dueAt)} proof=${proof}` };
    },
  },
  {
    id: 'compliance-register-whats-due',
    typeId: 'compliance-register',
    params: { business: 'a café in Portland' },
    prepare: REGISTER,
    message: 'What’s due in the next 60 days?',
    reads: [],
    check: () => ({ ok: true, detail: 'a question changes no file' }),
    reply: (text) => {
      const overdue = /extinguisher/i.test(text);
      const permit = /permit/i.test(text);
      const strays = /business license/i.test(text) && !/not due|later|after/i.test(text);
      return overdue && permit && !strays
        ? { ok: true, detail: 'named the overdue inspection and the permit, left the license out' }
        : { ok: false, detail: `overdue=${overdue} permit=${permit} strayLicense=${strays}` };
    },
  },
];

export default cases;
