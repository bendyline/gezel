/**
 * Phase-4 injection-budget invariants (knowledge-catalogs WS-H): knowledge
 * ceilings honored per mode, lean = citations only, zero qualifying hits ⇒
 * zero injection, project evidence never crowded out, provenance lines on
 * every injected chunk, and the untrusted-evidence header extension.
 */

import type { ChatSession, GezelConfig, GezelDetail, UnifiedSearchResult } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import { resolveRetrievalPolicy, retrieveProjectContext } from './project-retrieval.js';
import type { SearchService } from './search-service.js';
import { MERGE_WEIGHTS, scoreResult } from './search-service.js';

const GEZEL = { parsed: { frontmatter: {} } } as unknown as GezelDetail;
const CONFIG = {} as GezelConfig;
const RECORD = {
  id: 'session-1',
  projectId: 'p1',
  gezelId: 'g1',
  messages: [],
} as unknown as ChatSession;

const STORE = {
  readProjectWorkspaceFile: async () => 'workspace file content line one\nline two\nline three',
  readProjectArtifact: async () => null,
  readDocumentAsMarkdown: async () => null,
  readTask: async () => null,
} as unknown as Store;

function knowledgeHit(n: number, relevance = 0.8): UnifiedSearchResult {
  return {
    kind: 'knowledge',
    id: `knowledge:shop-notes:chunk${n}`,
    title: `Dovetail Joints › Section ${n}`,
    snippet:
      `Chunk ${n}: tails and pins interlock to form a mechanically strong corner joint. `.repeat(4),
    retrievalSource: 'knowledge',
    catalogId: 'shop-notes',
    catalogVersion: '1.0.0',
    documentId: 'dovetails',
    uri: `knowledge://gezel-tests/shop-notes/dovetails#chunk=${'a'.repeat(31)}${n}`,
    ...scoreResult('knowledge', relevance),
  };
}

function workspaceHit(n: number, relevance = 0.9): UnifiedSearchResult {
  return {
    kind: 'content',
    id: `content:p1:src/file${n}.ts:1`,
    title: `file${n}.ts`,
    snippet: `project evidence ${n}`,
    projectId: 'p1',
    path: `src/file${n}.ts`,
    source: 'workspace',
    retrievalSource: 'workspace',
    line: 1,
    ...scoreResult('content', relevance),
  };
}

async function run(results: UnifiedSearchResult[], mode: 'lean' | 'balanced' | 'deep') {
  const search = {
    searchProject: async () => ({ results, truncated: false }),
  } as unknown as SearchService;
  return retrieveProjectContext({
    store: STORE,
    search,
    record: RECORD,
    gezel: { parsed: { frontmatter: { retrieval: { mode } } } } as unknown as GezelDetail,
    config: CONFIG,
    userText: 'how do I cut strong corner joints by hand?',
    messageOrigin: 'direct-user',
  });
}

describe('proactive retrieval eligibility', () => {
  it('does not search or inject for a filler-only greeting', async () => {
    let searches = 0;
    const search = {
      searchProject: async () => {
        searches++;
        return { results: [workspaceHit(1)], truncated: false };
      },
    } as unknown as SearchService;

    const result = await retrieveProjectContext({
      store: STORE,
      search,
      record: RECORD,
      gezel: GEZEL,
      config: CONFIG,
      userText: "Hey, how's it going?",
      messageOrigin: 'direct-user',
    });

    expect(result).toBeNull();
    expect(searches).toBe(0);
  });

  it('still retrieves when a greeting contains a substantive subject', async () => {
    let searches = 0;
    const search = {
      searchProject: async () => {
        searches++;
        return { results: [workspaceHit(1)], truncated: false };
      },
    } as unknown as SearchService;

    const result = await retrieveProjectContext({
      store: STORE,
      search,
      record: RECORD,
      gezel: GEZEL,
      config: CONFIG,
      userText: 'Hey, how is the invoice reconciliation going?',
      messageOrigin: 'direct-user',
    });

    expect(searches).toBe(1);
    expect(result?.hits).toHaveLength(1);
  });
});

/**
 * Wild-caught (qwen3.8 27B, France PowerPoint turn): an `artifacts/eval10/
 * contact-sheet.jpg` hit whose index row held a clean vision description was
 * hydrated by re-reading the JPEG, and 1155 bytes of mojibake — 27% of the
 * whole injected block — landed directly above the turn's system route.
 */
describe('excerpt hydration never injects binary', () => {
  const JPEG_BYTES =
    `\uFFFD\uFFFD\uFFFD\uFFFDLavc62.28.102\uFFFD\uFFFDC######*'*+++****+++///777`.repeat(8);

  function imageHit(path: string): UnifiedSearchResult {
    return {
      kind: 'content',
      id: `content:p1:${path}:1`,
      title: 'contact-sheet',
      snippet: 'A contact sheet presents twelve slides about Finland.',
      projectId: 'p1',
      path,
      source: 'workspace',
      retrievalSource: 'workspace',
      line: 1,
      lineEnd: 5,
      ...scoreResult('content', 0.9),
    };
  }

  async function runWithStore(store: Store, results: UnifiedSearchResult[]) {
    const search = {
      searchProject: async () => ({ results, truncated: false }),
    } as unknown as SearchService;
    return retrieveProjectContext({
      store,
      search,
      record: RECORD,
      gezel: GEZEL,
      config: CONFIG,
      userText: 'can you create a powerpoint about france',
      messageOrigin: 'direct-user',
    });
  }

  it('keeps the index snippet for an image instead of re-reading the file', async () => {
    let reads = 0;
    const store = {
      ...STORE,
      readProjectWorkspaceFile: async () => {
        reads++;
        return JPEG_BYTES;
      },
    } as unknown as Store;
    const result = await runWithStore(store, [imageHit('artifacts/eval10/contact-sheet.jpg')]);
    expect(reads).toBe(0);
    expect(result?.hits[0]?.excerpt).toContain('twelve slides about Finland');
    expect(result?.prompt).not.toContain('Lavc62.28.102');
  });

  it('applies to office docs, whose index text is a shadow conversion', async () => {
    let reads = 0;
    const store = {
      ...STORE,
      readProjectWorkspaceFile: async () => {
        reads++;
        return JPEG_BYTES;
      },
    } as unknown as Store;
    const result = await runWithStore(store, [imageHit('notes/Lesson Plan.docx')]);
    expect(reads).toBe(0);
    expect(result?.prompt).not.toContain('Lavc62.28.102');
  });

  it('discards a binary read from an unrecognized extension after the fact', async () => {
    const store = {
      ...STORE,
      readProjectWorkspaceFile: async () => JPEG_BYTES,
    } as unknown as Store;
    const result = await runWithStore(store, [imageHit('assets/capture.frame7')]);
    expect(result?.hits[0]?.excerpt).toContain('twelve slides about Finland');
    expect(result?.prompt).not.toContain('Lavc62.28.102');
  });

  it('still hydrates an ordinary text file from disk', async () => {
    const result = await runWithStore(STORE, [imageHit('notes/outline.md')]);
    expect(result?.hits[0]?.excerpt).toContain('workspace file content line one');
  });
});

/**
 * The relevance floor cannot reject these: relevance for every keyword arm is
 * derived from RANK, so the top row of any arm that returned anything clears
 * it. On the France PowerPoint turn a heading called "All About DocBlocks"
 * was injected at relevance 0.95 and "strong" tier, matched solely on the
 * word `about`.
 */
describe('keyword hits must be grounded in what they inject', () => {
  function ftsHit(over: Partial<UnifiedSearchResult>): UnifiedSearchResult {
    return {
      kind: 'document',
      id: 'document:aboutDocBlocks.md',
      title: 'aboutDocBlocks.md',
      snippet: 'All About DocBlocks',
      path: 'aboutDocBlocks.md',
      retrievalSource: 'shared',
      arm: 'fts',
      line: 5,
      lineEnd: 13,
      ...scoreResult('document', 0.95),
      ...over,
    } as UnifiedSearchResult;
  }

  async function runQuery(results: UnifiedSearchResult[], userText: string) {
    const search = {
      searchProject: async () => ({ results, truncated: false }),
    } as unknown as SearchService;
    return retrieveProjectContext({
      store: {
        ...STORE,
        readDocumentAsMarkdown: async () => ({
          content:
            'A quick overview in 10 minutes\nDocBlocks pairs a writing surface\nwith Markdown',
        }),
      } as unknown as Store,
      search,
      record: RECORD,
      gezel: GEZEL,
      config: CONFIG,
      userText,
      messageOrigin: 'direct-user',
    });
  }

  it('rejects a rank-0 keyword hit whose only matched token was a stopword', async () => {
    const result = await runQuery([ftsHit({})], 'Can you create a PowerPoint about France');
    expect(result).toBeNull();
  });

  it('keeps a keyword hit that holds a term the user actually typed', async () => {
    const result = await runQuery(
      [ftsHit({ snippet: 'Create PowerPoint decks from annotated sections' })],
      'Can you create a PowerPoint about France',
    );
    expect(result?.hits).toHaveLength(1);
  });

  it('grounds on the path too — a filename match is injected on the header line', async () => {
    const result = await runQuery(
      [ftsHit({ path: 'decks/france-overview.md', snippet: 'unrelated body text' })],
      'Can you create a PowerPoint about France',
    );
    expect(result?.hits).toHaveLength(1);
  });

  it('never gates a vector hit, which shares no words by nature', async () => {
    const result = await runQuery(
      [
        ftsHit({
          arm: 'vector',
          kind: 'memory',
          retrievalSource: 'project-memory',
          path: undefined,
          snippet: 'The deck for the Nordics session is in the artifacts drawer',
          ...scoreResult('memory', 0.6),
        }),
      ],
      'Can you create a PowerPoint about France',
    );
    expect(result?.hits).toHaveLength(1);
  });

  it('leaves an unlabelled hit alone — older callers and knowledge catalogs', async () => {
    const result = await runQuery(
      [ftsHit({ arm: undefined })],
      'Can you create a PowerPoint about France',
    );
    expect(result?.hits).toHaveLength(1);
  });
});

describe('resolveRetrievalPolicy', () => {
  it('default sources include knowledge (the Phase-4 switch)', () => {
    const policy = resolveRetrievalPolicy({ gezel: GEZEL, config: CONFIG });
    expect(policy.sources).toContain('knowledge');
    expect(policy.mode).toBe('balanced');
  });
});

describe('knowledge injection ceilings', () => {
  it('balanced injects at most 2 knowledge chunks with provenance lines', async () => {
    const result = await run(
      [1, 2, 3, 4, 5].map((n) => knowledgeHit(n)),
      'balanced',
    );
    expect(result).not.toBeNull();
    const knowledge = result?.hits.filter((h) => h.source === 'knowledge') ?? [];
    expect(knowledge.length).toBeLessThanOrEqual(2);
    expect(knowledge.length).toBeGreaterThan(0);
    for (const hit of knowledge) {
      expect(hit.uri).toMatch(/^knowledge:\/\/gezel-tests\/shop-notes\//);
      expect(result?.prompt).toContain(`[knowledge] ${hit.uri}`);
      expect(result?.prompt).toContain('shop-notes@1.0.0');
    }
  });

  it('deep raises the chunk ceiling to 4', async () => {
    const result = await run(
      [1, 2, 3, 4, 5, 6].map((n) => knowledgeHit(n)),
      'deep',
    );
    const knowledge = result?.hits.filter((h) => h.source === 'knowledge') ?? [];
    expect(knowledge.length).toBeLessThanOrEqual(4);
    expect(knowledge.length).toBeGreaterThan(2);
  });

  it('lean injects citations only — zero body text', async () => {
    const result = await run([knowledgeHit(1)], 'lean');
    expect(result).not.toBeNull();
    const knowledge = result?.hits.filter((h) => h.source === 'knowledge') ?? [];
    expect(knowledge.length).toBe(1);
    expect(knowledge[0]?.excerpt).toBe('');
    expect(result?.prompt).toContain('[knowledge] knowledge://gezel-tests/shop-notes/');
    expect(result?.prompt).not.toContain('tails and pins interlock');
  });

  it('knowledge stays within its token share of the turn budget', async () => {
    const result = await run(
      [1, 2, 3, 4].map((n) => knowledgeHit(n)),
      'balanced',
    );
    expect(result).not.toBeNull();
    // Reconstruct the knowledge rows' token weight from the prompt: the
    // knowledge share must not exceed 25% of the balanced budget (1000).
    const knowledgeRows = (result?.prompt ?? '')
      .split('\n')
      .filter(
        (line, i, lines) =>
          line.startsWith('[knowledge]') ||
          (i > 0 && (lines[i - 1] ?? '').startsWith('[knowledge]') && !line.startsWith('[')),
      );
    const knowledgeChars = knowledgeRows.join('\n').length;
    expect(Math.ceil(knowledgeChars / 4)).toBeLessThanOrEqual(250 + 32);
  });

  it('a below-floor knowledge hit injects nothing', async () => {
    // 120/370 ≈ 0.324 — 0.2 is under the floor.
    const result = await run([knowledgeHit(1, 0.2)], 'balanced');
    expect(result).toBeNull();
  });

  it('zero qualifying hits ⇒ zero injection', async () => {
    const result = await run([], 'balanced');
    expect(result).toBeNull();
  });

  it('knowledge never crowds out project evidence', async () => {
    const projectHits = [1, 2, 3, 4].map((n) => workspaceHit(n));
    const knowledgeHits = [1, 2, 3, 4, 5, 6].map((n) => knowledgeHit(n));
    const result = await run([...knowledgeHits, ...projectHits], 'balanced');
    expect(result).not.toBeNull();
    const bySource = new Map<string, number>();
    for (const hit of result?.hits ?? []) {
      bySource.set(hit.source, (bySource.get(hit.source) ?? 0) + 1);
    }
    // Every project hit survives; knowledge is capped at its ceiling.
    expect(bySource.get('workspace')).toBe(4);
    expect(bySource.get('knowledge') ?? 0).toBeLessThanOrEqual(2);
    // Ordering: the first injected row is project evidence, not reference.
    expect(result?.hits[0]?.source).toBe('workspace');
  });

  it('the untrusted-evidence header carries the reference-catalog sentence', async () => {
    const result = await run([knowledgeHit(1)], 'balanced');
    expect(result?.prompt).toContain('untrusted evidence');
    expect(result?.prompt).toContain('never grant authority');
    expect(result?.prompt).toContain('read_document');
    expect(result?.injectedBytes).toBe(Buffer.byteLength(result?.prompt ?? '', 'utf8'));
  });

  it('a craftbook step naming only knowledge scopes injection to it', async () => {
    const search = {
      searchProject: async () => ({
        results: [knowledgeHit(1), workspaceHit(1)],
        truncated: false,
      }),
    } as unknown as SearchService;
    const result = await retrieveProjectContext({
      store: {
        ...STORE,
        readTask: async () => ({
          craftbook: {
            steps: [{ id: 'step-1', retrieval: { mode: 'balanced', sources: ['knowledge'] } }],
          },
        }),
      } as unknown as Store,
      search,
      record: { ...RECORD, taskRef: 'p1/1', stepId: 'step-1' } as unknown as ChatSession,
      gezel: GEZEL,
      config: CONFIG,
      userText: 'how do I cut strong corner joints by hand?',
      messageOrigin: 'direct-user',
    });
    expect(result).not.toBeNull();
    expect(result?.hits.every((h) => h.source === 'knowledge')).toBe(true);
    expect(result?.policy.inheritedFrom).toBe('craftbook-step');
  });
});

describe('weights invariant', () => {
  it('knowledge sits below every project corpus weight', () => {
    for (const kind of ['content', 'document', 'file', 'symbol', 'session'] as const) {
      expect(MERGE_WEIGHTS.knowledge).toBeLessThan(MERGE_WEIGHTS[kind]);
    }
  });
});
