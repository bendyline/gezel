import type { RetrievalTraceSurface } from '@bendyline/gezel';
import type { BenchCorpus, DocRole } from './build.ts';
import { FAMILIES, type FamilySplit, STEP_PROSE_QUERIES } from './families.ts';

/**
 * Labeled retrieval-bench queries. Grades come from each document's ROLE in
 * its family, by one rule per query class, so a label can only be wrong if
 * the rule is — and every document is judged for every query: another
 * family's documents and all filler are grade 0 by construction (distinct
 * fictional entities in distinct domains). Frozen before the first scored
 * run; changes go through LABELS.md with a reason.
 */

export type QueryClass =
  | 'title'
  | 'paraphrase'
  | 'launch'
  | 'direct'
  | 'step-prose'
  | 'absent'
  | 'near-miss-only'
  | 'multi-corpus';

/** answer: something relevant exists; abstain: inject nothing; either: abstain or grade 1 is right. */
export type Expectation = 'answer' | 'abstain' | 'either';

export type Grade = 0 | 1 | 2;

export interface BenchQuery {
  id: string;
  familyId: string | null;
  split: FamilySplit;
  class: QueryClass;
  text: string;
  surfaces: RetrievalTraceSurface[];
  expect: Expectation;
  /** docKey → grade, for every document with a non-zero grade. */
  labels: Record<string, Grade>;
  /** docKeys that are deliberate decoys for this query (grade 0). */
  decoys: string[];
  /** references surface: the book whose words are not subject terms. */
  craftbookName?: string;
  /** turn surface: how the preview frames the text. */
  messageOrigin: 'direct-user' | 'cross-gezel';
}

export const LAUNCH_BOOK = 'PowerPoint from Content';

const ANSWER_GRADES: Partial<Record<DocRole, Grade>> = {
  golden: 2,
  counterpart: 2,
  background: 1,
  nearMiss: 1,
  narrow: 1,
};

const GRADES_BY_CLASS: Record<QueryClass, Partial<Record<DocRole, Grade>>> = {
  title: ANSWER_GRADES,
  paraphrase: ANSWER_GRADES,
  launch: ANSWER_GRADES,
  direct: ANSWER_GRADES,
  'multi-corpus': { counterpart: 2, golden: 1, background: 1 },
  'near-miss-only': { golden: 1, narrow: 1, counterpart: 1 },
  absent: {},
  'step-prose': {},
};

const EXPECTATION: Record<QueryClass, Expectation> = {
  title: 'answer',
  paraphrase: 'answer',
  launch: 'answer',
  direct: 'answer',
  'multi-corpus': 'answer',
  'near-miss-only': 'either',
  absent: 'abstain',
  'step-prose': 'abstain',
};

const SURFACES: Record<QueryClass, RetrievalTraceSurface[]> = {
  title: ['search', 'turn'],
  paraphrase: ['search', 'turn'],
  launch: ['references', 'turn'],
  direct: ['search', 'turn'],
  'multi-corpus': ['search', 'turn'],
  'near-miss-only': ['turn', 'references'],
  absent: ['search', 'turn', 'references'],
  'step-prose': ['turn'],
};

const DECOY_ROLES: ReadonlySet<DocRole> = new Set(['lexicalDecoy', 'lookalike', 'boilerplate']);

export function buildBenchQueries(corpus: BenchCorpus): BenchQuery[] {
  const queries: BenchQuery[] = [];
  for (const family of FAMILIES) {
    const familyDocs = corpus.docs.filter((doc) => doc.familyId === family.id);
    const decoys = familyDocs.filter((doc) => DECOY_ROLES.has(doc.role)).map((doc) => doc.docKey);
    const byClass: Array<[QueryClass, string]> = [
      ['title', family.queries.title],
      ['paraphrase', family.queries.paraphrase],
      ['launch', family.queries.launch],
      ['direct', family.queries.direct],
      ['absent', family.queries.absent],
      ['near-miss-only', family.queries.nearMissOnly],
      ['multi-corpus', family.queries.multiCorpus],
    ];
    for (const [queryClass, text] of byClass) {
      const grades = GRADES_BY_CLASS[queryClass];
      const labels: Record<string, Grade> = {};
      for (const doc of familyDocs) {
        const grade = grades[doc.role];
        if (grade) labels[doc.docKey] = grade;
      }
      queries.push({
        id: `${family.id}:${queryClass}`,
        familyId: family.id,
        split: family.split,
        class: queryClass,
        text,
        surfaces: SURFACES[queryClass],
        expect: EXPECTATION[queryClass],
        labels,
        decoys,
        ...(queryClass === 'launch' || SURFACES[queryClass].includes('references')
          ? { craftbookName: LAUNCH_BOOK }
          : {}),
        messageOrigin: 'direct-user',
      });
    }
  }
  const boilerplate = corpus.docs.filter((doc) => doc.role === 'boilerplate').map((d) => d.docKey);
  for (const step of STEP_PROSE_QUERIES) {
    queries.push({
      id: `step-prose:${step.id}`,
      familyId: null,
      split: step.split,
      class: 'step-prose',
      text: step.text,
      surfaces: SURFACES['step-prose'],
      expect: 'abstain',
      labels: {},
      decoys: boilerplate,
      messageOrigin: 'cross-gezel',
    });
  }
  return queries;
}

/** Which corpora a surface can return. The references surface reads only reference corpora. */
export function reachableCorpora(
  surface: RetrievalTraceSurface,
): ReadonlySet<'knowledge' | 'shared' | 'workspace'> {
  return surface === 'references'
    ? new Set(['knowledge', 'shared'])
    : new Set(['knowledge', 'shared', 'workspace']);
}
