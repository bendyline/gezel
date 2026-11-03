import { isoDaysAhead, list, records } from '../app-parity-helpers.ts';
import type { ParityCase } from '../app-parity.ts';

const EVENT = {
  tool: 'page_set_event',
  input: {
    occasion: 'Fernwood Client Summit',
    date: isoDaysAhead(38),
    time: '3:00 to 8:30 pm',
    headcount: 80,
    budget: 18000,
  },
};
const VENDORS = [
  EVENT,
  {
    tool: 'page_add_vendor',
    input: {
      name: 'Sorrel Kitchen',
      category: 'catering',
      status: 'booked',
      contract: 7200,
      deposit: 1800,
      depositDueAt: isoDaysAhead(9),
      contact: 'Joelle, 555-0142',
    },
  },
  {
    tool: 'page_add_vendor',
    input: {
      name: 'Brightwave AV',
      category: 'av',
      status: 'booked',
      contract: 1450,
      deposit: 500,
      depositDueAt: isoDaysAhead(-6),
    },
  },
  { tool: 'page_record_payment', input: { name: 'Brightwave AV', amount: 500, kind: 'deposit' } },
];
const GUESTS = [
  EVENT,
  ...(
    [
      ['Mei Lin', 'Juniper Press', 'yes', 'vegetarian'],
      ['Owen Park', 'Juniper Press', 'yes', 'none'],
      ['Dana Whitfield', 'Harbor Street Café', 'yes', ''],
      ['Leo Marsh', 'Alder & Co', 'yes', ''],
      ['Tomás Rivera', 'Brightline Electric', 'invited', ''],
      ['Hannah Cole', 'Calder Bikes', 'no', ''],
    ] as const
  ).map(([name, company, response, dietary]) => ({
    tool: 'page_add_guest',
    input: { name, company, response, ...(dietary ? { dietary } : {}) },
  })),
];

const cases: ParityCase[] = [
  {
    id: 'event-desk-deposit-paid',
    typeId: 'event-desk',
    params: { event: 'our client summit', date: '' },
    prepare: VENDORS,
    message: 'We paid Sorrel Kitchen’s $1,800 deposit',
    reads: ['vendors.json', 'budget.json'],
    check: (docs) => {
      const vendors = records(docs['vendors.json']);
      const sorrel = vendors.find((r) => /sorrel kitchen/i.test(String(r.fields?.name)));
      if (!sorrel) return { ok: false, detail: 'Sorrel Kitchen left vendors.json' };
      if (vendors.length !== 2) return { ok: false, detail: `${vendors.length} vendors` };
      const paid = list(docs['budget.json'], 'entries').filter(
        (e) => (e.data as { vendorId?: unknown } | undefined)?.vendorId === sorrel.id,
      );
      const total = paid.reduce((sum, e) => sum + Number(e.amountCents ?? 0), 0);
      return paid.length === 1 && total === 180_000
        ? { ok: true, detail: `one $1,800 payment to ${sorrel.id}` }
        : { ok: false, detail: `payments=${paid.length} totalCents=${total}` };
    },
  },
  {
    id: 'event-desk-dietary',
    typeId: 'event-desk',
    params: { event: 'our client summit', date: '' },
    prepare: GUESTS,
    message: 'Who still needs a dietary answer?',
    reads: [],
    check: () => ({ ok: true, detail: 'a question changes no file' }),
    reply: (text) => {
      const dana = /Dana/i.test(text);
      const leo = /Leo/i.test(text);
      const strays = /\bMei\b/i.test(text) && !/vegetarian|answered|already/i.test(text);
      return dana && leo && !strays
        ? { ok: true, detail: 'named Dana and Leo, not the guests who answered' }
        : { ok: false, detail: `dana=${dana} leo=${leo} strayMei=${strays}` };
    },
  },
];

export default cases;
