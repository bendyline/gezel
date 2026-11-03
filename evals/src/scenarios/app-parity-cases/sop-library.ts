import { isoDaysAhead, records } from '../app-parity-helpers.ts';
import type { ParityCase } from '../app-parity.ts';

const LIBRARY = [
  {
    tool: 'page_save_procedure',
    input: {
      title: 'Opening checklist',
      area: 'opening',
      owner: 'Dana',
      steps:
        '1. Disarm the alarm at the back door.\n2. Turn on the espresso machine; it needs 25 minutes to warm up.\n3. Count a $150 float into the till.',
      reviewedAt: isoDaysAhead(-40),
    },
  },
  {
    tool: 'page_save_procedure',
    input: {
      title: 'Closing the espresso machine',
      area: 'closing',
      owner: 'Luis',
      steps:
        '1. Backflush each group head with a Cafiza tablet, then twice with clear water.\n2. Soak the portafilter baskets in the blue tub overnight.\n3. Purge the steam wands and wipe them down.\n4. Switch the machine to eco mode. Never turn it fully off overnight.',
      reviewedAt: isoDaysAhead(-95),
    },
  },
  {
    tool: 'page_save_procedure',
    input: {
      title: 'Cash drop and safe count',
      area: 'money',
      owner: 'Priya',
      steps:
        '1. Count the safe at 5 pm with a second person watching.\n2. Write the count and both initials in the cash book.',
      reviewedAt: isoDaysAhead(-210),
    },
  },
  {
    tool: 'page_save_procedure',
    input: {
      title: 'Weekly deep clean of the grinder',
      area: 'cleaning',
      owner: 'Luis',
      steps:
        '1. Empty the hopper and run the grinder until it is clear.\n2. Run one dose of grinder-cleaning tablets through.\n3. Brush out the burr chamber. Do not use water.',
      reviewedAt: isoDaysAhead(-200),
    },
  },
];

const cases: ParityCase[] = [
  {
    id: 'sop-library-reviewed',
    typeId: 'sop-library',
    params: { business: 'a café in Portland' },
    prepare: LIBRARY,
    message: 'Luis went through the grinder deep clean, it’s still right',
    reads: ['sops/index.json'],
    check: (docs) => {
      const grinder = records(docs['sops/index.json']).filter((r) =>
        /grinder/i.test(String(r.fields?.title)),
      );
      if (grinder.length !== 1)
        return { ok: false, detail: `${grinder.length} grinder procedures` };
      const sop = grinder[0]!;
      const today = isoDaysAhead(0);
      return sop.fields?.lastReviewedAt === today && sop.status === 'current'
        ? { ok: true, detail: `grinder deep clean reviewed ${today}` }
        : {
            ok: false,
            detail: `lastReviewedAt=${String(sop.fields?.lastReviewedAt)} status=${String(sop.status)}`,
          };
    },
  },
  {
    id: 'sop-library-how-to',
    typeId: 'sop-library',
    params: { business: 'a café in Portland' },
    prepare: LIBRARY,
    message: 'How do I close the espresso machine?',
    reads: [],
    check: () => ({ ok: true, detail: 'a question changes no file' }),
    reply: (text) => {
      // Only the written steps say "blue tub" and "eco mode"; a generic answer has neither.
      const tub = /blue tub/i.test(text);
      const eco = /eco mode/i.test(text);
      return tub && eco
        ? { ok: true, detail: 'answered from the written procedure' }
        : { ok: false, detail: `blueTub=${tub} ecoMode=${eco}` };
    },
  },
];

export default cases;
