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
    uri: `knowledge://shop-notes/dovetails#chunk=${'a'.repeat(31)}${n}`,
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
      expect(hit.uri).toMatch(/^knowledge:\/\/shop-notes\//);
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
    expect(result?.prompt).toContain('[knowledge] knowledge://shop-notes/');
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
