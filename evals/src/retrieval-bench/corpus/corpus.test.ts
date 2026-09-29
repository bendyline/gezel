import { describe, expect, it } from 'vitest';
import { buildBenchCorpus } from './build.ts';
import { FAMILIES } from './families.ts';
import { buildBenchQueries, reachableCorpora } from './queries.ts';

const corpus = buildBenchCorpus('proj-bench');
const queries = buildBenchQueries(corpus);
const docsByKey = new Map(corpus.docs.map((doc) => [doc.docKey, doc]));

describe('retrieval-bench corpus', () => {
  it('is deterministic', () => {
    expect(buildBenchCorpus('proj-bench')).toEqual(corpus);
  });

  it('keeps document keys unique and splits families 8 dev / 4 test', () => {
    expect(docsByKey.size).toBe(corpus.docs.length);
    expect(FAMILIES.filter((f) => f.split === 'dev')).toHaveLength(8);
    expect(FAMILIES.filter((f) => f.split === 'test')).toHaveLength(4);
  });

  // Every document is judged for every query only because filler can never be
  // about a family: a shared entity name would make an unlabeled filler row
  // secretly relevant.
  it('never gives filler a name that appears in family text', () => {
    // Filler text is fixed templates plus one generated name per document,
    // so the generated names are the only way filler can touch a family.
    const familyText = FAMILIES.flatMap((family) => [
      ...[
        family.golden,
        family.counterpart,
        family.background,
        family.nearMiss,
        family.narrow,
        family.lexicalDecoy,
        family.lookalike,
        family.boilerplate,
      ].flatMap((doc) => [doc.title, doc.body]),
      ...Object.values(family.queries),
    ])
      .join(' ')
      .toLowerCase();
    const fillerTitles = [
      ...corpus.knowledge.filter((doc) => doc.id.startsWith('filler-')).map((doc) => doc.title),
      ...corpus.shared
        .filter((doc) => doc.path.includes('/library/'))
        .map((doc) => doc.content.slice(2)),
      ...corpus.workspace
        .filter((doc) => doc.path.startsWith('notes/'))
        .map((doc) => doc.content.slice(2)),
    ];
    for (const title of fillerTitles) {
      const name = title.split(/[\s:]/)[0]!.toLowerCase();
      expect(new RegExp(`\\b${name}\\b`).test(familyText), `filler name "${name}"`).toBe(false);
    }
  });
});

describe('retrieval-bench queries', () => {
  it('have unique ids and labels that point at real documents', () => {
    expect(new Set(queries.map((q) => q.id)).size).toBe(queries.length);
    for (const query of queries) {
      for (const key of [...Object.keys(query.labels), ...query.decoys]) {
        expect(docsByKey.has(key), `${query.id} → ${key}`).toBe(true);
      }
      for (const decoy of query.decoys) expect(query.labels[decoy]).toBeUndefined();
    }
  });

  it('give every answerable query a grade-2 document each of its surfaces can reach', () => {
    for (const query of queries.filter((q) => q.expect === 'answer')) {
      for (const surface of query.surfaces) {
        const reachable = reachableCorpora(surface);
        const best = Object.entries(query.labels).filter(
          ([key, grade]) => grade === 2 && reachable.has(docsByKey.get(key)!.corpus),
        );
        expect(best.length, `${query.id} on ${surface}`).toBeGreaterThan(0);
      }
    }
  });

  it('expects abstention with no relevant document', () => {
    for (const query of queries.filter((q) => q.expect === 'abstain')) {
      expect(Object.keys(query.labels), query.id).toEqual([]);
    }
  });
});
