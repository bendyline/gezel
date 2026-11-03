import { isoDaysAhead, records } from '../app-parity-helpers.ts';
import type { ParityCase } from '../app-parity.ts';

const REGIONAL_DUE = isoDaysAhead(9);
const SMALL_PRESS_DUE = isoDaysAhead(30);
// Juniper Press's demo pipeline, without the stage moves (their page tools summon a reaction).
const PIPELINE = [
  {
    tool: 'page_add_opportunity',
    input: {
      title: 'Regional Arts Fund Project Grant',
      funder: 'Cascade Regional Arts Fund',
      kind: 'grant',
      deadline: REGIONAL_DUE,
      ask: 10000,
      fit: 'strong',
    },
  },
  {
    tool: 'page_add_opportunity',
    input: {
      title: 'Small Press Grant',
      funder: 'Oregon Literary Arts',
      kind: 'grant',
      deadline: SMALL_PRESS_DUE,
      ask: 8000,
      fit: 'strong',
    },
  },
  {
    tool: 'page_add_opportunity',
    input: {
      title: 'Creative Communities RFP',
      funder: 'City Office of Arts & Culture',
      kind: 'rfp',
      deadline: isoDaysAhead(41),
      ask: 15000,
      fit: 'good',
    },
  },
  {
    tool: 'page_add_requirement',
    input: {
      opportunity: 'Regional Arts Fund Project Grant',
      titles: ['Project narrative', 'Budget narrative', 'Two letters of support'],
    },
  },
  { tool: 'page_check_requirement', input: { requirement: 'Project narrative' } },
  {
    tool: 'page_add_requirement',
    input: {
      opportunity: 'Small Press Grant',
      titles: ['Narrative draft', '2027 publication plan'],
    },
  },
];

const deadlineOf = (docs: Record<string, unknown>, title: string) =>
  records(docs['opportunities.json']).find((r) => String(r.fields?.title) === title)?.fields
    ?.deadline;

const cases: ParityCase[] = [
  {
    id: 'grants-and-proposals-extended',
    typeId: 'grants-and-proposals',
    params: {
      organization: 'a small literary press',
      focus: 'new translations and author readings',
    },
    prepare: PIPELINE,
    message: 'The Regional Arts Fund extended its deadline by two weeks',
    reads: ['opportunities.json'],
    check: (docs) => {
      const regional = deadlineOf(docs, 'Regional Arts Fund Project Grant');
      const smallPress = deadlineOf(docs, 'Small Press Grant');
      const want = isoDaysAhead(23);
      return regional === want && smallPress === SMALL_PRESS_DUE
        ? { ok: true, detail: `Regional Arts Fund moved from ${REGIONAL_DUE} to ${want}` }
        : {
            ok: false,
            detail: `regional=${String(regional)} (want ${want}) smallPress=${String(smallPress)}`,
          };
    },
  },
  {
    id: 'grants-and-proposals-whats-due',
    typeId: 'grants-and-proposals',
    params: {
      organization: 'a small literary press',
      focus: 'new translations and author readings',
    },
    prepare: PIPELINE,
    message: 'What’s due next, and what’s still missing?',
    reads: [],
    check: () => ({ ok: true, detail: 'a question changes no file' }),
    reply: (text) => {
      const regional = /regional arts/i.test(text);
      const missing = /budget narrative|letters? of support/i.test(text);
      return regional && missing
        ? { ok: true, detail: 'named the Regional Arts Fund deadline and what it still needs' }
        : { ok: false, detail: `regional=${regional} missing=${missing}` };
    },
  },
];

export default cases;
