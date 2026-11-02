import { isoDaysAhead, records } from '../app-parity-helpers.ts';
import type { ParityCase } from '../app-parity.ts';

const STUDIO = [
  {
    tool: 'page_add_piece',
    input: {
      title: 'How we price brand projects',
      format: 'article',
      status: 'published',
      assignee: 'Maya',
      publishAt: isoDaysAhead(-6),
    },
  },
  {
    tool: 'page_add_piece',
    input: {
      title: 'Case study: Harbor Street Café rebrand',
      format: 'case-study',
      status: 'edit',
      assignee: 'Jonah',
      publishAt: isoDaysAhead(5),
    },
  },
  {
    tool: 'page_add_piece',
    input: {
      title: 'A field guide to brand guidelines',
      format: 'guide',
      status: 'draft',
      assignee: 'Maya',
      publishAt: isoDaysAhead(12),
    },
  },
  {
    tool: 'page_add_piece',
    input: {
      title: 'Why we stopped doing spec work',
      format: 'essay',
      status: 'brief',
      assignee: 'Jonah',
      publishAt: isoDaysAhead(30),
    },
  },
];

const cases: ParityCase[] = [
  {
    id: 'content-studio-repurpose',
    typeId: 'content-studio',
    params: {
      business: 'a six-person design studio',
      audience: 'small business owners planning a rebrand',
    },
    prepare: STUDIO,
    message: 'Turn the pricing post into a newsletter and three posts',
    reads: ['pieces.json', 'calendar.json'],
    check: (docs) => {
      const pricing = records(docs['pieces.json']).find((r) =>
        /price brand projects/i.test(String(r.fields?.title)),
      );
      if (!pricing) return { ok: false, detail: 'the pricing post left pieces.json' };
      const mine = records(docs['calendar.json']).filter((r) => r.fields?.pieceId === pricing.id);
      const newsletters = mine.filter((r) => r.fields?.format === 'newsletter').length;
      const posts = mine.filter((r) => r.fields?.format === 'social-post').length;
      return newsletters === 1 && posts === 3
        ? { ok: true, detail: `${pricing.id} got 1 newsletter and 3 social posts` }
        : {
            ok: false,
            detail: `newsletters=${newsletters} socialPosts=${posts} for ${pricing.id}`,
          };
    },
  },
  {
    id: 'content-studio-next-two-weeks',
    typeId: 'content-studio',
    params: {
      business: 'a six-person design studio',
      audience: 'small business owners planning a rebrand',
    },
    prepare: STUDIO,
    message: 'What’s publishing in the next two weeks?',
    reads: [],
    check: () => ({ ok: true, detail: 'a question changes no file' }),
    reply: (text) => {
      const caseStudy = /case study|harbor street/i.test(text);
      const guide = /brand guidelines|field guide/i.test(text);
      const stray =
        /spec work/i.test(text) &&
        !/later|after|not until|beyond|outside|further out|next month/i.test(text);
      return caseStudy && guide && !stray
        ? { ok: true, detail: 'named the case study and the guide, left the spec-work essay out' }
        : { ok: false, detail: `caseStudy=${caseStudy} guide=${guide} straySpecWork=${stray}` };
    },
  },
];

export default cases;
