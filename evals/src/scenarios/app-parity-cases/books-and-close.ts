import { list, num } from '../app-parity-helpers.ts';
import type { ParityCase } from '../app-parity.ts';

/** A day in last calendar month, YYYY-MM-DD in local time (clamped to the month's length). */
function lastMonth(day: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1, 12);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const entry = (payee: string, amount: number, day: number, category: string) => ({
  tool: 'page_record_entry',
  input: { payee, amount, date: lastMonth(day), category },
});

// Last month for Brightline Electric: income 10,730.00, cost of jobs 1,912.40, expenses 7,768.40.
const BOOKS = [
  entry('Alder Street remodel', 7480, 6, 'sales'),
  entry('Kim residence panel upgrade', 3250, 14, 'sales'),
  entry('Cascade Electric Supply', 1912.4, 3, 'materials'),
  entry('Payroll', 2925, 9, 'payroll'),
  entry('Payroll', 2925, 23, 'payroll'),
  entry('Shop rent', 1600, 1, 'rent'),
  entry('Pacific Fuel', 318.4, 12, 'vehicle'),
];
const NET = '1,049.20';

const cases: ParityCase[] = [
  {
    id: 'books-and-close-categorize',
    typeId: 'books-and-close',
    params: { business: 'a three-person electrical contractor', currency: 'USD' },
    prepare: [...BOOKS, entry('Brightway Auto', 189.5, 21, 'uncategorized')],
    message: 'The Brightway Auto charge was the van’s oil change',
    reads: ['ledger.json'],
    check: (docs) => {
      const hits = list(docs['ledger.json'], 'entries').filter((e) =>
        /brightway/i.test(JSON.stringify(e.data ?? {})),
      );
      if (hits.length !== 1) return { ok: false, detail: `${hits.length} Brightway Auto entries` };
      const hit = hits[0]!;
      return hit.category === 'vehicle' && num(hit.amountCents) === 18950
        ? { ok: true, detail: 'Brightway Auto moved to vehicle, still 189.50, not duplicated' }
        : {
            ok: false,
            detail: `category=${String(hit.category)} amountCents=${String(hit.amountCents)}`,
          };
    },
  },
  {
    id: 'books-and-close-last-month',
    typeId: 'books-and-close',
    params: { business: 'a three-person electrical contractor', currency: 'USD' },
    prepare: BOOKS,
    message: 'How did last month do?',
    reads: [],
    check: () => ({ ok: true, detail: 'a question changes no file' }),
    reply: (text) => {
      const net = /1,?049(?:\.20)?\b/.test(text);
      const income = /10,?730/.test(text);
      return net
        ? { ok: true, detail: `named the net profit ${NET}${income ? ' and the income' : ''}` }
        : { ok: false, detail: `net ${NET} missing (income named: ${income})` };
    },
  },
];

export default cases;
