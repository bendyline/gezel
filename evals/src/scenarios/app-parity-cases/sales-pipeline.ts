import { isoDaysAhead, num, records } from '../app-parity-helpers.ts';
import type { ParityCase } from '../app-parity.ts';

// Weighted at the stage chances: 8,400 x 75% + 14,800 x 50% + 22,500 x 25% = 19,325.
const PIPELINE = [
  {
    tool: 'page_add_deal',
    input: {
      title: 'Harbor Street Café kitchen rewire',
      company: 'Harbor Street Café',
      value: 8400,
      status: 'negotiation',
      followUpAt: isoDaysAhead(0),
    },
  },
  {
    tool: 'page_add_deal',
    input: {
      title: 'Fernwood Studio office lighting retrofit',
      company: 'Fernwood Studio',
      value: 14800,
      status: 'proposal',
      followUpAt: isoDaysAhead(-2),
    },
  },
  {
    tool: 'page_add_deal',
    input: {
      title: 'Juniper Press warehouse EV chargers',
      company: 'Juniper Press',
      value: 22500,
      status: 'qualified',
      followUpAt: isoDaysAhead(3),
    },
  },
];

const cases: ParityCase[] = [
  {
    id: 'sales-pipeline-value-grows',
    typeId: 'sales-pipeline',
    params: { business: 'a three-person electrical contractor' },
    prepare: PIPELINE,
    message: 'Juniper Press added the loading dock lights, another $3,400',
    reads: ['deals.json'],
    check: (docs) => {
      const juniper = records(docs['deals.json']).filter((r) =>
        /juniper/i.test(`${String(r.fields?.title)} ${String(r.fields?.company)}`),
      );
      if (juniper.length === 0)
        return { ok: false, detail: 'the Juniper Press deal left the pipeline' };
      const values = juniper.map((r) => num(r.fields?.valueCents));
      if (juniper.length > 1) {
        return {
          ok: false,
          detail: `${juniper.length} Juniper deals, values ${values.join(', ')}`,
        };
      }
      return values[0] === 2_590_000
        ? { ok: true, detail: 'Juniper Press grew from $22,500 to $25,900 on the same deal' }
        : { ok: false, detail: `Juniper Press valueCents=${String(values[0])}, expected 2590000` };
    },
  },
  {
    id: 'sales-pipeline-forecast',
    typeId: 'sales-pipeline',
    params: { business: 'a three-person electrical contractor' },
    prepare: PIPELINE,
    message: 'What’s our weighted forecast?',
    reads: [],
    check: () => ({ ok: true, detail: 'a question changes no file' }),
    reply: (text) => {
      const exact = /19,?325/.test(text);
      const total = /45,?700/.test(text);
      return exact
        ? { ok: true, detail: 'quoted the weighted forecast, $19,325' }
        : {
            ok: false,
            detail: `weighted $19,325 missing${total ? ' (quoted the unweighted value instead)' : ''}`,
          };
    },
  },
];

export default cases;
