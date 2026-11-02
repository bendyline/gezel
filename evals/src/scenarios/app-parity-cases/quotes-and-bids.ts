import { list, num, records } from '../app-parity-helpers.ts';
import type { ParityCase } from '../app-parity.ts';

const line = (
  title: string,
  description: string,
  kind: string,
  qty: number,
  unit: string,
  rate: number,
) => ({
  tool: 'page_add_quote_line',
  input: { title, description, kind, qty, unit, rate },
});

const CAFE = 'Harbor Street Café kitchen rewire';
const JUNIPER = 'Juniper Press warehouse EV chargers';
// Tax 8.25% on materials. Café: 5,887.00 + 8.25% of 2,102.00 = 6,060.42.
// Juniper: 5,406.00 + 8.25% of 3,696.00 = 5,710.92; with 6 more electrician hours, 6,280.92.
const QUOTES = [
  {
    tool: 'page_set_quote_terms',
    input: { taxRate: 8.25, taxOn: 'materials', validDays: 30, followUpDays: 5 },
  },
  {
    tool: 'page_start_quote',
    input: { title: CAFE, client: 'Harbor Street Café', contact: 'Dana' },
  },
  line(CAFE, 'Electrician labor', 'labor', 24, 'hour', 95),
  line(CAFE, 'Apprentice labor', 'labor', 24, 'hour', 55),
  line(CAFE, 'Kitchen circuits: wire, breakers and boxes', 'materials', 1, 'lot', 1640),
  line(CAFE, 'GFCI receptacles', 'materials', 12, 'each', 38.5),
  line(CAFE, 'Permit and inspection', 'other', 1, 'each', 185),
  { tool: 'page_start_quote', input: { title: JUNIPER, client: 'Juniper Press', contact: 'Owen' } },
  line(JUNIPER, 'Electrician labor', 'labor', 18, 'hour', 95),
  line(JUNIPER, 'Level 2 EV chargers', 'materials', 4, 'each', 689),
  line(JUNIPER, '60A breakers and wire', 'materials', 1, 'lot', 940),
];

const cases: ParityCase[] = [
  {
    id: 'quotes-and-bids-more-hours',
    typeId: 'quotes-and-bids',
    params: { business: 'a three-person electrical contractor' },
    prepare: QUOTES,
    message: 'Add 6 more electrician hours to the Juniper Press quote',
    reads: ['quotes.json'],
    check: (docs) => {
      const juniper = records(docs['quotes.json']).filter((r) =>
        /juniper/i.test(String(r.fields?.title)),
      );
      if (juniper.length !== 1) return { ok: false, detail: `${juniper.length} Juniper quotes` };
      const lines = list(juniper[0]!.fields, 'lines');
      const hours = lines
        .filter((l) => /electrician/i.test(String(l.description)))
        .reduce((sum, l) => sum + (num(l.qty) ?? 0), 0);
      const total = num(juniper[0]!.fields?.totalCents);
      return hours === 24 && total === 628_092
        ? { ok: true, detail: `24 electrician hours across ${lines.length} lines, total $6,280.92` }
        : {
            ok: false,
            detail: `electrician hours=${hours} totalCents=${String(total)}, expected 24 and 628092`,
          };
    },
  },
  {
    id: 'quotes-and-bids-quote-total',
    typeId: 'quotes-and-bids',
    params: { business: 'a three-person electrical contractor' },
    prepare: QUOTES,
    message: 'What’s the total on the café kitchen rewire quote?',
    reads: [],
    check: () => ({ ok: true, detail: 'a question changes no file' }),
    reply: (text) => {
      const exact = /6,?060\.42/.test(text);
      const subtotalOnly = /5,?887(?:\.00)?/.test(text);
      return exact
        ? { ok: true, detail: 'quoted the exact total, $6,060.42' }
        : {
            ok: false,
            detail: `$6,060.42 missing${subtotalOnly ? ' (quoted the subtotal without tax)' : ''}`,
          };
    },
  },
];

export default cases;
