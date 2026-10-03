import type { ChatMessage } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { EvidenceLedger, MAX_WRITE_REFUSALS, removeCitationMarkers } from './evidence-ledger.js';

const article =
  'George Washington was born on February 22, 1732, in Westmoreland County, Virginia. His father Augustine Washington died in 1743. He married Martha Dandridge Custis on January 6, 1759.';

describe('EvidenceLedger', () => {
  it('numbers evidence tool results once and leaves other tools alone', () => {
    const ledger = new EvidenceLedger();
    const label = ledger.labelToolResult('wikipedia_read', { title: 'George Washington' }, article);
    expect(label).toBe(
      '[1] Evidence from `wikipedia_read` — Wikipedia: George Washington. Cite facts from it as [1].',
    );
    expect(
      ledger.labelToolResult('wikipedia_read', { title: 'George Washington' }, article),
    ).toContain('[1]');
    expect(ledger.labelToolResult('write_artifact', { path: 'x.md' }, 'ok')).toBeNull();
    expect(
      ledger.labelToolResult(
        'web_search',
        { query: 'Martha Washington' },
        '1. **Martha Washington**',
      ),
    ).toContain('[2]');
  });

  it('keeps the address of a page it read so the citation can open it', () => {
    const ledger = new EvidenceLedger();
    ledger.labelToolResult(
      'wikipedia_read',
      { title: 'Mount Vernon' },
      '# Mount Vernon\nhttps://en.wikipedia.org/wiki/Mount_Vernon\n\nAn estate.',
    );
    expect(ledger.grounding('Mount Vernon is an estate [1].')?.evidence[0]).toMatchObject({
      title: 'Wikipedia: Mount Vernon',
      ref: 'https://en.wikipedia.org/wiki/Mount_Vernon',
    });
  });

  it('refuses a document insert that states an unsourced fact, then lets it through with a warning', () => {
    const ledger = new EvidenceLedger();
    ledger.beginTurn('Write about Washington.');
    ledger.labelToolResult('wikipedia_read', { title: 'George Washington' }, article);
    const bad = {
      text: 'Washington was born in 1732 [1]. He had a son named Samuel.',
      format: 'markdown',
    };
    for (let i = 0; i < MAX_WRITE_REFUSALS; i++) {
      const verdict = ledger.checkDocumentWrite('doc_insert_text', bad);
      expect(verdict?.kind).toBe('reject');
      if (verdict?.kind === 'reject') expect(verdict.error).toContain('no evidence shows "Samuel"');
    }
    const through = ledger.checkDocumentWrite('doc_insert_text', bad);
    expect(through).toEqual({
      kind: 'allow',
      args: { text: 'Washington was born in 1732. He had a son named Samuel.', format: 'markdown' },
    });
    const unverified = ledger.takeUnverifiedWrites();
    expect(unverified.places).toEqual(['the document']);
    expect(ledger.grounding('Done.', unverified.sentences)?.problems.map((p) => p.status)).toEqual([
      'uncited',
    ]);
    expect(ledger.takeUnverifiedWrites()).toEqual({ sentences: [], places: [] });
  });

  it('tells a refused writer which lookup to call next, or to cut when it has none', () => {
    const ledger = new EvidenceLedger();
    ledger.beginTurn('');
    const write = { path: 'notes.md', content: 'Patsy Custis died in 1778.' };
    const bare = ledger.checkProseFileWrite('write_file', write);
    expect(bare?.kind === 'reject' && bare.error).toContain('If the person can give you a source');
    ledger.setLookupTools(['read_file', 'wikipedia_read', 'wikipedia_search', 'write_file']);
    const armed = ledger.checkProseFileWrite('write_artifact', write);
    expect(armed?.kind === 'reject' && armed.error).toContain(
      'call `wikipedia_search` now for the subject (also: `wikipedia_read`)',
    );
    expect(armed?.kind === 'reject' && armed.error).toContain('Do not ask the person for sources');
  });

  it('holds a saved prose file to the evidence, and leaves code and data files alone', () => {
    const ledger = new EvidenceLedger();
    ledger.beginTurn('Write a paragraph about Martha Washington.');
    const fromMemory = {
      path: 'martha_washington_children.md',
      content: 'Her son, John Parke Custis, was born in 1753. Patsy died at the age of fourteen.',
    };
    const refused = ledger.checkProseFileWrite('write_file', fromMemory);
    expect(refused?.kind).toBe('reject');
    if (refused?.kind === 'reject') {
      expect(refused.error).toContain('Not saved');
      expect(refused.error).toContain('"1753"');
    }
    ledger.labelToolResult(
      'wikipedia_read',
      { title: 'John Parke Custis' },
      'John Parke Custis (November 27, 1754 – November 5, 1781) was the son of Martha Dandridge Custis and Daniel Parke Custis.',
    );
    const researched = {
      path: 'notes/martha.md',
      content: '# Martha\n\nHer son, John Parke Custis, was born in 1754 [9] and died in 1781.',
    };
    expect(ledger.checkProseFileWrite('write_artifact', researched)).toEqual({
      kind: 'allow',
      args: {
        path: 'notes/martha.md',
        content: '# Martha\n\nHer son, John Parke Custis, was born in 1754 and died in 1781.',
      },
    });
    const cited = {
      path: 'notes/martha.md',
      content:
        'Her son, John Parke Custis, was born in 1754 [1]. He was her only surviving son [8].',
    };
    expect(ledger.checkProseFileWrite('write_artifact', cited)).toEqual({
      kind: 'allow',
      args: {
        path: 'notes/martha.md',
        content:
          'Her son, John Parke Custis, was born in 1754 [1]. He was her only surviving son.\n\n## Sources\n\n[1] Wikipedia: John Parke Custis\n',
      },
    });
    expect(
      ledger.checkProseFileWrite('write_file', {
        path: 'src/app.ts',
        content: 'const year = 1753;',
      }),
    ).toBeNull();
    expect(ledger.hooks().checkWrite('write_file', fromMemory)?.kind).toBe('reject');
  });

  it('passes a grounded insert with its markers removed, and ignores non-document tools', () => {
    const ledger = new EvidenceLedger();
    ledger.beginTurn('');
    ledger.labelToolResult('wikipedia_read', { title: 'George Washington' }, article);
    expect(
      ledger.checkDocumentWrite('doc_insert_text', {
        text: '- His father, Augustine Washington, died in 1743 [1].',
      }),
    ).toEqual({
      kind: 'allow',
      args: { text: '- His father, Augustine Washington, died in 1743.' },
    });
    expect(
      ledger.checkDocumentWrite('slide_insert', {
        title: 'Family [1]',
        bullets: ['Married Martha Dandridge Custis in 1759 [1]'],
      }),
    ).toEqual({
      kind: 'allow',
      args: { title: 'Family', bullets: ['Married Martha Dandridge Custis in 1759'] },
    });
    expect(
      ledger.checkDocumentWrite('write_artifact', { text: 'Anything at all, 1999.' }),
    ).toBeNull();
  });

  it('accepts what the person said without a source', () => {
    const ledger = new EvidenceLedger();
    ledger.beginTurn('My great-aunt Ilse Brandt emigrated in 1951.');
    expect(
      ledger.checkDocumentWrite('doc_insert_text', { text: 'Ilse Brandt emigrated in 1951.' })
        ?.kind,
    ).toBe('allow');
  });

  it('continues numbering after a restart and treats old numbers as real but unchecked', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'x',
        at: '',
        grounding: {
          evidence: [{ n: 4, kind: 'tool' }],
          counts: {
            supported: 0,
            cited: 0,
            unattributed: 0,
            uncited: 0,
            unsupported: 0,
            badCitation: 0,
          },
          problems: [],
        },
      },
    ] as ChatMessage[];
    const ledger = EvidenceLedger.fromMessages(messages);
    expect(
      ledger.labelToolResult('search', { query: 'Mount Vernon' }, 'Mount Vernon is an estate.'),
    ).toContain('[5]');
    const g = ledger.grounding('Washington died at Mount Vernon in 1799 [4].');
    expect(g?.counts.cited).toBe(1);
    expect(g?.problems).toEqual([]);
  });

  it('records the evidence a reply cites with a short excerpt', () => {
    const ledger = new EvidenceLedger();
    ledger.beginTurn('');
    ledger.labelToolResult('wikipedia_read', { title: 'George Washington' }, article);
    const g = ledger.grounding(
      'Washington was born in 1732 [1]. He grew up in Virginia. He became a surveyor in 1749.',
    );
    expect(g?.evidence).toEqual([
      expect.objectContaining({
        n: 1,
        kind: 'tool',
        tool: 'wikipedia_read',
        title: 'Wikipedia: George Washington',
      }),
    ]);
    expect(g?.counts).toMatchObject({ supported: 1, unattributed: 1, uncited: 1 });
    expect(g?.problems).toEqual([
      { text: 'He became a surveyor in 1749.', status: 'uncited', missing: ['1749'] },
    ]);
  });
});

describe('removeCitationMarkers', () => {
  it('keeps indentation and markdown links', () => {
    expect(
      removeCitationMarkers(
        '- Born 1732 [1].\n  - Married 1759 [1, 2].\nSee [the article](https://x) [3].',
      ),
    ).toBe('- Born 1732.\n  - Married 1759.\nSee [the article](https://x).');
  });
});
