import { num, records } from '../app-parity-helpers.ts';
import type { ParityCase } from '../app-parity.ts';

const STOCKROOM = [
  {
    tool: 'page_add_item',
    input: {
      name: 'Espresso beans',
      unit: 'bag',
      onHand: 6,
      reorderPoint: 8,
      par: 20,
      supplier: 'Coastal Roasters',
      leadDays: 5,
      unitCost: 42,
    },
  },
  {
    tool: 'page_add_item',
    input: {
      name: 'Whole milk',
      unit: 'gallon',
      onHand: 14,
      reorderPoint: 12,
      par: 40,
      supplier: 'Valley Dairy',
      leadDays: 2,
      unitCost: 4.2,
    },
  },
  {
    tool: 'page_add_item',
    input: {
      name: 'Oat milk',
      unit: 'carton',
      onHand: 0,
      reorderPoint: 10,
      par: 36,
      supplier: 'Valley Dairy',
      unitCost: 3.8,
    },
  },
  {
    tool: 'page_add_item',
    input: {
      name: 'Vanilla syrup',
      unit: 'bottle',
      onHand: 2,
      reorderPoint: 3,
      par: 12,
      supplier: 'Harbor Wholesale',
      leadDays: 4,
      unitCost: 9.75,
    },
  },
  {
    tool: 'page_add_item',
    input: {
      name: '12 oz hot cups',
      unit: 'sleeve of 50',
      onHand: 9,
      reorderPoint: 6,
      par: 24,
      supplier: 'Bayside Paper Co.',
      leadDays: 7,
      unitCost: 6.5,
    },
  },
];

const cases: ParityCase[] = [
  {
    id: 'inventory-reorder-used-beans',
    typeId: 'inventory-reorder',
    params: { business: 'a café in Portland' },
    prepare: STOCKROOM,
    message: 'We used 3 bags of espresso beans today',
    reads: ['items.json'],
    check: (docs) => {
      const beans = records(docs['items.json']).filter((r) =>
        /espresso beans/i.test(String(r.fields?.name)),
      );
      if (beans.length !== 1) return { ok: false, detail: `${beans.length} espresso bean records` };
      const onHand = num(beans[0]!.fields?.onHand);
      return onHand === 3
        ? { ok: true, detail: 'espresso beans went from 6 to 3 bags' }
        : { ok: false, detail: `onHand=${String(beans[0]!.fields?.onHand)} (expected 6 - 3 = 3)` };
    },
  },
  {
    id: 'inventory-reorder-running-low',
    typeId: 'inventory-reorder',
    params: { business: 'a café in Portland' },
    prepare: STOCKROOM,
    message: 'What’s running low?',
    reads: [],
    check: () => ({ ok: true, detail: 'a question changes no file' }),
    reply: (text) => {
      const oat = /oat milk/i.test(text);
      const beans = /espresso/i.test(text);
      const syrup = /vanilla/i.test(text);
      const strayMilk =
        /whole milk/i.test(text) &&
        !/fine|enough|above|plenty|\bok\b|okay|in stock|not low|good shape|well stocked/i.test(
          text,
        );
      return oat && beans && syrup && !strayMilk
        ? {
            ok: true,
            detail: 'named oat milk, espresso beans and vanilla syrup; left whole milk out',
          }
        : {
            ok: false,
            detail: `oat=${oat} beans=${beans} syrup=${syrup} strayWholeMilk=${strayMilk}`,
          };
    },
  },
];

export default cases;
