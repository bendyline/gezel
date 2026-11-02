import { addMonths, isoDaysAhead, records } from '../app-parity-helpers.ts';
import type { ParityCase } from '../app-parity.ts';

const LINEN_END = isoDaysAhead(42);
const DESK = [
  {
    tool: 'page_add_contract',
    input: {
      title: 'Linen and apron service',
      vendor: 'Bayside Linen',
      category: 'linen',
      annualCost: 3600,
      endAt: LINEN_END,
      autoRenew: 'yes',
      noticeDays: 30,
      owner: 'Priya',
    },
  },
  {
    tool: 'page_add_contract',
    input: {
      title: 'Water cooler and filter rental',
      vendor: 'Clearwater Water Co.',
      category: 'equipment',
      annualCost: 1140,
      endAt: isoDaysAhead(58),
      autoRenew: 'yes',
      noticeDays: 30,
      owner: 'Luis',
    },
  },
  {
    tool: 'page_add_contract',
    input: {
      title: 'Waste and recycling pickup',
      vendor: 'Tidewater Waste',
      category: 'services',
      annualCost: 4320,
      endAt: isoDaysAhead(20),
      autoRenew: 'yes',
      noticeDays: 60,
      owner: 'Luis',
    },
  },
  {
    tool: 'page_add_contract',
    input: {
      title: 'Point-of-sale software',
      vendor: 'Squarepoint POS',
      category: 'software',
      annualCost: 1188,
      endAt: isoDaysAhead(230),
      autoRenew: 'yes',
      noticeDays: 30,
      owner: 'Priya',
    },
  },
];

const cases: ParityCase[] = [
  {
    id: 'vendor-contracts-renewed',
    typeId: 'vendor-contracts',
    params: { business: 'a café in Portland' },
    prepare: DESK,
    message: 'We renewed the linen service for another year at $3,900',
    reads: ['contracts.json'],
    check: (docs) => {
      const linen = records(docs['contracts.json']).filter((r) =>
        /linen/i.test(String(r.fields?.title)),
      );
      if (linen.length !== 1) return { ok: false, detail: `${linen.length} linen contracts` };
      const contract = linen[0]!;
      const rolled = contract.fields?.endAt === addMonths(LINEN_END, 12);
      const priced = contract.fields?.annualCents === 390000;
      return rolled && priced && contract.status === 'active'
        ? {
            ok: true,
            detail: `linen renewed through ${String(contract.fields?.endAt)} at $3,900 a year`,
          }
        : {
            ok: false,
            detail: `endAt=${String(contract.fields?.endAt)} annualCents=${String(contract.fields?.annualCents)} status=${String(contract.status)}`,
          };
    },
  },
  {
    id: 'vendor-contracts-decisions',
    typeId: 'vendor-contracts',
    params: { business: 'a café in Portland' },
    prepare: DESK,
    message: 'Which contracts need a decision in the next 90 days?',
    reads: [],
    check: () => ({ ok: true, detail: 'a question changes no file' }),
    reply: (text) => {
      const linen = /linen/i.test(text);
      const cooler = /water cooler|cooler/i.test(text);
      // Naming the POS as what comes next, with its 2027 date, is right.
      const strays =
        /point-of-sale|\bPOS\b|squarepoint/i.test(text) &&
        !/not until|later|after|outside|\bnext\b|2027/i.test(text);
      return linen && cooler && !strays
        ? { ok: true, detail: 'named the linen and water cooler notice dates, left the POS out' }
        : { ok: false, detail: `linen=${linen} cooler=${cooler} strayPos=${strays}` };
    },
  },
];

export default cases;
