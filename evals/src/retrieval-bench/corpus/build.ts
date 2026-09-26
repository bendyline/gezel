import type { CatalogDocument } from '@bendyline/gezel';
import { FAMILIES, type Family } from './families.ts';

/**
 * The retrieval-bench corpus: every family's eight documents placed in their
 * corpora, plus deterministic filler. Filler matters because relevance on
 * the keyword and catalog arms is anchored to RANK — with a pool of eight
 * documents a query's top hit always scores high, and nothing can be learned
 * about filtering.
 */

export const BENCH_PUBLISHER = 'gezel-bench';
export const BENCH_CATALOG = 'retrieval-bench';
export const BENCH_CATALOG_VERSION = '1.0.0';

export type FamilyRole =
  | 'golden'
  | 'counterpart'
  | 'background'
  | 'nearMiss'
  | 'narrow'
  | 'lexicalDecoy'
  | 'lookalike'
  | 'boilerplate';

export type DocRole = FamilyRole | 'filler';

export interface PlacedDoc {
  /** Stable per-document key, matching `retrievalDocKey` at run time. */
  docKey: string;
  familyId: string | null;
  role: DocRole;
  corpus: 'knowledge' | 'shared' | 'workspace';
}

export interface BenchCorpus {
  knowledge: CatalogDocument[];
  shared: Array<{ path: string; content: string }>;
  workspace: Array<{ path: string; content: string }>;
  docs: PlacedDoc[];
}

export const KNOWLEDGE_FILLER_COUNT = 140;
export const SHARED_FILLER_COUNT = 24;
export const WORKSPACE_FILLER_COUNT = 36;

export function knowledgeDocKey(docId: string): string {
  return `knowledge://${BENCH_PUBLISHER}/${BENCH_CATALOG}/${docId}`;
}

export function workspaceDocKey(projectId: string, path: string): string {
  return `workspace:${projectId}:${path}`;
}

export function sharedDocKey(path: string): string {
  return `shared:${path}`;
}

/** Shared-library paths are namespaced so the bench never touches a person's own documents. */
export const SHARED_ROOT = 'retrieval-bench';

export function buildBenchCorpus(projectId: string): BenchCorpus {
  const knowledge: CatalogDocument[] = [];
  const shared: BenchCorpus['shared'] = [];
  const workspace: BenchCorpus['workspace'] = [];
  const docs: PlacedDoc[] = [];

  const addKnowledge = (
    id: string,
    title: string,
    body: string,
    topic: string,
    place: Omit<PlacedDoc, 'docKey' | 'corpus'>,
  ) => {
    knowledge.push({
      id,
      title,
      slug: id,
      summary: body.slice(0, 120),
      language: 'en',
      topicPath: [topic],
      markdown: `# ${title}\n\n${body}\n`,
    });
    docs.push({ ...place, docKey: knowledgeDocKey(id), corpus: 'knowledge' });
  };

  for (const family of FAMILIES) {
    for (const role of KNOWLEDGE_ROLES) {
      const doc = family[role];
      addKnowledge(`${family.id}-${role}`, doc.title, doc.body, family.domain, {
        familyId: family.id,
        role,
      });
    }
    const counterpart = family.counterpart;
    const content = `# ${counterpart.title}\n\n${counterpart.body}\n`;
    if (counterpart.surface === 'shared') {
      const path = `${SHARED_ROOT}/${counterpart.path}`;
      shared.push({ path, content });
      docs.push({
        docKey: sharedDocKey(path),
        familyId: family.id,
        role: 'counterpart',
        corpus: 'shared',
      });
    } else {
      workspace.push({ path: counterpart.path, content });
      docs.push({
        docKey: workspaceDocKey(projectId, counterpart.path),
        familyId: family.id,
        role: 'counterpart',
        corpus: 'workspace',
      });
    }
  }

  const random = mulberry32(0x5eed_2026);
  for (let i = 0; i < KNOWLEDGE_FILLER_COUNT; i++) {
    const filler = fillerArticle(random, i);
    addKnowledge(`filler-${i}`, filler.title, filler.body, filler.domain, {
      familyId: null,
      role: 'filler',
    });
  }
  for (let i = 0; i < SHARED_FILLER_COUNT; i++) {
    const note = fillerNote(random, i, 'policy');
    const path = `${SHARED_ROOT}/library/${note.slug}.md`;
    shared.push({ path, content: `# ${note.title}\n\n${note.body}\n` });
    docs.push({ docKey: sharedDocKey(path), familyId: null, role: 'filler', corpus: 'shared' });
  }
  for (let i = 0; i < WORKSPACE_FILLER_COUNT; i++) {
    const note = fillerNote(random, i, 'project');
    const path = `notes/${note.slug}.md`;
    workspace.push({ path, content: `# ${note.title}\n\n${note.body}\n` });
    docs.push({
      docKey: workspaceDocKey(projectId, path),
      familyId: null,
      role: 'filler',
      corpus: 'workspace',
    });
  }

  return { knowledge, shared, workspace, docs };
}

export const KNOWLEDGE_ROLES = [
  'golden',
  'background',
  'nearMiss',
  'narrow',
  'lexicalDecoy',
  'lookalike',
  'boilerplate',
] as const satisfies readonly Exclude<FamilyRole, 'counterpart'>[];

/** The catalog's topic list: every family domain and filler domain. */
export function benchTopics(): Array<{ id: string; name: string }> {
  return [
    ...new Set([
      ...FAMILIES.map((family: Family) => family.domain),
      ...FILLER_DOMAINS.map((domain) => domain.id),
    ]),
  ].map((id) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1) }));
}

/**
 * Deterministic filler catalog documents for other fixtures (the
 * annotated-work scenarios): the same generator the bench uses, under its own
 * seed and id prefix so the two corpora never share a document.
 */
export function fillerKnowledgeDocuments(
  count: number,
  opts: { seed: number; idPrefix: string },
): CatalogDocument[] {
  const random = mulberry32(opts.seed);
  return Array.from({ length: count }, (_, i) => {
    const filler = fillerArticle(random, i);
    const id = `${opts.idPrefix}-${i}`;
    return {
      id,
      title: filler.title,
      slug: id,
      summary: filler.body.slice(0, 120),
      language: 'en',
      topicPath: [filler.domain],
      markdown: `# ${filler.title}\n\n${filler.body}\n`,
    };
  });
}

// ── filler ────────────────────────────────────────────────────────────────

const NAME_HEADS = [
  'Ab',
  'Bel',
  'Cad',
  'Dra',
  'Eg',
  'Fen',
  'Gal',
  'Hib',
  'Is',
  'Jor',
  'Kal',
  'Lum',
  'Nel',
  'Ob',
  'Pra',
  'Quil',
  'Ros',
  'Sab',
  'Tam',
  'Ul',
  'Vib',
  'Wyn',
  'Yar',
  'Zen',
];
const NAME_TAILS = [
  'ane',
  'bury',
  'dale',
  'ett',
  'fold',
  'gard',
  'heim',
  'ika',
  'ley',
  'mont',
  'nor',
  'oth',
  'quist',
  'rin',
  'stead',
  'ton',
  'vik',
  'wick',
];

interface FillerDomain {
  id: string;
  things: string[];
  facts: string[];
}

const FILLER_DOMAINS: FillerDomain[] = [
  {
    id: 'geography',
    things: ['Lake', 'Pass', 'Island', 'Valley', 'Plateau'],
    facts: [
      'It lies at the edge of a limestone basin and freezes most winters.',
      'Shepherds used it as a summer grazing route for centuries.',
      'A narrow-gauge railway reached it in 1911 and closed in 1958.',
      'Its shoreline is protected as a nesting area for terns.',
    ],
  },
  {
    id: 'crafts',
    things: ['weave', 'glaze', 'knot', 'joinery style'],
    facts: [
      'Makers dye the yarn with walnut husks before the loom is strung.',
      'The glaze is fired twice and cracks into a fine web as it cools.',
      'Apprentices spend a full year on practice pieces before selling work.',
      'Guild marks were stamped on the underside of finished pieces.',
    ],
  },
  {
    id: 'sport',
    things: ['Rovers', 'Athletic', 'Rowing Club', 'Cycling Classic'],
    facts: [
      'The club plays in green and white and was promoted in 2018.',
      'Its home ground holds about 6,000 spectators.',
      'The race climbs three hills and finishes on a cobbled square.',
      'The rowing club trains on the canal before dawn.',
    ],
  },
  {
    id: 'literature',
    things: ['Chronicles', 'poems', 'saga', 'letters'],
    facts: [
      'The text survives in a single manuscript copied by two scribes.',
      'Critics praised its plain style and its long winter scenes.',
      'The author wrote it while working as a customs clerk.',
      'A modern translation appeared in 1986.',
    ],
  },
  {
    id: 'botany',
    things: ['moss', 'fern', 'orchid', 'sedge'],
    facts: [
      'It grows on north-facing rocks in damp woodland.',
      'The plant flowers for only two weeks in early summer.',
      'Its spores are carried by wind across open moorland.',
      'It was first recorded by a schoolteacher in 1893.',
    ],
  },
  {
    id: 'architecture',
    things: ['Hall', 'Bridge', 'Tower', 'Arcade'],
    facts: [
      'The building was designed in a stripped classical style.',
      'Its timber roof was replaced after a fire in 1932.',
      'The arcade connects two market streets under a glass roof.',
      'Restoration uncovered painted ceilings hidden by plaster.',
    ],
  },
  {
    id: 'economics',
    things: ['Accord', 'levy', 'index', 'cooperative bank'],
    facts: [
      'The levy funds rural roads and is collected quarterly.',
      'The index tracks the price of a basket of household goods.',
      'Members hold one share each regardless of deposit size.',
      'The accord removed tariffs on grain between two provinces.',
    ],
  },
  {
    id: 'zoology',
    things: ['vole', 'warbler', 'newt', 'beetle'],
    facts: [
      'It feeds mainly at dusk on seeds and small insects.',
      'The species was reintroduced to the wetlands in 2004.',
      'Males sing from high perches to mark territory.',
      'Its population is monitored by volunteer surveys each spring.',
    ],
  },
];

function fillerName(random: () => number): string {
  return pick(random, NAME_HEADS) + pick(random, NAME_TAILS);
}

function fillerArticle(
  random: () => number,
  index: number,
): { title: string; body: string; domain: string } {
  const domain = FILLER_DOMAINS[index % FILLER_DOMAINS.length]!;
  const name = fillerName(random);
  const thing = pick(random, domain.things);
  const facts = shuffled(random, domain.facts).slice(0, 3);
  return {
    title: `${name} ${thing}`,
    body: `${name} ${thing.toLowerCase()} is a subject in ${domain.id}. ${facts.join(' ')}`,
    domain: domain.id,
  };
}

const NOTE_TOPICS: Record<'policy' | 'project', string[]> = {
  policy: [
    'expense claims',
    'travel booking',
    'laptop replacement',
    'visitor badges',
    'parking permits',
    'holiday requests',
  ],
  project: [
    'kickoff meeting',
    'supplier call',
    'budget review',
    'retro',
    'hiring panel',
    'site survey',
  ],
};

const NOTE_FACTS = [
  'Send the form to the office manager at least five working days ahead.',
  'Approvals over the limit need a second signature from finance.',
  'Keep receipts for twelve months in the shared drive.',
  'The next review is scheduled for the first Monday of the quarter.',
  'Action items are tracked in the team board under the owner’s name.',
  'Questions go to the facilities channel rather than direct messages.',
];

function fillerNote(
  random: () => number,
  index: number,
  kind: 'policy' | 'project',
): { title: string; slug: string; body: string } {
  const name = fillerName(random);
  const topic = NOTE_TOPICS[kind][index % NOTE_TOPICS[kind].length]!;
  const facts = shuffled(random, NOTE_FACTS).slice(0, 2);
  const title = kind === 'policy' ? `${name} office: ${topic}` : `${name} ${topic}`;
  const slug = `${name.toLowerCase()}-${topic.replace(/\s+/g, '-')}-${index}`;
  return { title, slug, body: facts.join(' ') };
}

// ── deterministic randomness ─────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

function shuffled<T>(random: () => number, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
