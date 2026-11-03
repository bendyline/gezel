import { isoDaysAhead, records } from '../app-parity-helpers.ts';
import type { ParityCase } from '../app-parity.ts';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** The Monday of the week holding a YYYY-MM-DD day, as the forecast labels its weeks. */
function mondayOf(day: string): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A reply names a day as 2026-12-07, Dec 7, December 7 or 12/7. */
function namesDay(text: string, day: string): boolean {
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  const name = MONTHS[month - 1]!;
  return new RegExp(
    `${day}|\\b(?:${name}|${name.slice(0, 3)})\\.?\\s+${date}(?!\\d)|\\b${month}/${date}(?!\\d)`,
    'i',
  ).test(text);
}

const HOLLIS_DATE = isoDaysAhead(23);
const BRIGHTLINE = [
  { tool: 'page_set_balance', input: { amount: 9840, date: isoDaysAhead(0), cushion: 12000 } },
  {
    tool: 'page_add_cash_item',
    input: {
      name: 'Payroll',
      direction: 'out',
      amount: 5850,
      date: isoDaysAhead(4),
      recurs: 'biweekly',
    },
  },
  {
    tool: 'page_add_cash_item',
    input: {
      name: 'Cascade Electric Supply account',
      direction: 'out',
      amount: 3200,
      date: isoDaysAhead(12),
      recurs: 'monthly',
    },
  },
  {
    tool: 'page_add_cash_item',
    input: {
      name: 'Service calls (weekly average)',
      direction: 'in',
      amount: 1400,
      date: isoDaysAhead(5),
      recurs: 'weekly',
    },
  },
  {
    tool: 'page_add_cash_item',
    input: {
      name: 'Kim residence panel upgrade',
      direction: 'in',
      amount: 3250,
      date: isoDaysAhead(9),
      recurs: 'none',
    },
  },
  {
    tool: 'page_add_cash_item',
    input: {
      name: 'Hollis Bakery lighting retrofit',
      direction: 'in',
      amount: 7200,
      date: HOLLIS_DATE,
      recurs: 'none',
    },
  },
  {
    tool: 'page_add_cash_item',
    input: {
      name: 'Juniper Press warehouse lighting',
      direction: 'in',
      amount: 12400,
      date: isoDaysAhead(47),
      recurs: 'none',
    },
  },
];

// A flat plan with one big bill: the week the tax payment lands is the first below the cushion.
const TAX_DATE = isoDaysAhead(30);
const TAX_WEEK = mondayOf(TAX_DATE);
const FLAT = [
  { tool: 'page_set_balance', input: { amount: 20000, date: isoDaysAhead(0), cushion: 10000 } },
  {
    tool: 'page_add_cash_item',
    input: {
      name: 'Payroll',
      direction: 'out',
      amount: 4000,
      date: isoDaysAhead(3),
      recurs: 'biweekly',
    },
  },
  {
    tool: 'page_add_cash_item',
    input: {
      name: 'Maintenance retainer',
      direction: 'in',
      amount: 4500,
      date: isoDaysAhead(3),
      recurs: 'biweekly',
    },
  },
  {
    tool: 'page_add_cash_item',
    input: {
      name: 'Quarterly tax payment',
      direction: 'out',
      amount: 12500,
      date: TAX_DATE,
      recurs: 'none',
    },
  },
  {
    tool: 'page_add_cash_item',
    input: {
      name: 'Juniper Press warehouse lighting',
      direction: 'in',
      amount: 15000,
      date: isoDaysAhead(45),
      recurs: 'none',
    },
  },
];

const cases: ParityCase[] = [
  {
    id: 'cash-flow-planner-what-if-late',
    typeId: 'cash-flow-planner',
    params: { business: 'a three-person electrical contractor', currency: 'USD' },
    prepare: BRIGHTLINE,
    message: 'What if Hollis Bakery pays a month late?',
    reads: ['cashflow.json'],
    check: (docs) => {
      const all = records(docs['cashflow.json']);
      const hollis = all.filter((r) => /hollis/i.test(String(r.fields?.name ?? '')));
      if (hollis.length !== 1)
        return { ok: false, detail: `${hollis.length} Hollis items in the plan` };
      const base = hollis[0]!;
      if (base.status !== 'expected' || base.fields?.date !== HOLLIS_DATE) {
        return {
          ok: false,
          detail: `the plan itself changed: status=${String(base.status)} date=${String(base.fields?.date)}`,
        };
      }
      const delay = all.find(
        (r) =>
          r.status === 'whatif' && r.fields?.change === 'delay' && r.fields?.itemId === base.id,
      );
      const weeks = Number(delay?.fields?.weeks);
      return delay && weeks >= 4 && weeks <= 5
        ? {
            ok: true,
            detail: `what-if '${String(delay.fields?.scenario)}' delays Hollis ${weeks} weeks; plan untouched`,
          }
        : {
            ok: false,
            detail: delay
              ? `delay of ${String(delay.fields?.weeks)} weeks`
              : 'no what-if delay on the Hollis invoice',
          };
    },
  },
  {
    id: 'cash-flow-planner-when-tight',
    typeId: 'cash-flow-planner',
    params: { business: 'a three-person electrical contractor', currency: 'USD' },
    prepare: FLAT,
    message: 'When does cash get tight?',
    reads: [],
    check: () => ({ ok: true, detail: 'a question changes no file' }),
    reply: (text) => {
      const week = namesDay(text, TAX_WEEK) || namesDay(text, TAX_DATE);
      const cause = /\btax\b/i.test(text);
      const denies = /\b(never|stays above|no (?:week|point))\b/i.test(text) && !week;
      return (week || cause) && !denies
        ? {
            ok: true,
            detail: `named ${week ? `the week of ${TAX_WEEK}` : 'the tax payment'}${week && cause ? ' and its cause' : ''}`,
          }
        : { ok: false, detail: `week=${week} tax=${cause} denies=${denies}` };
    },
  },
];

export default cases;
