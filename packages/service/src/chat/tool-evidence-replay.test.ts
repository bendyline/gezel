import type { ChatMessageToolCall } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOOL_EVIDENCE_BUDGET_CHARS,
  type ReplaySourceMessage,
  buildToolEvidenceReplay,
  toolEvidenceBudgetChars,
} from './tool-evidence-replay.js';

const read = (path: string, resultText: string, over: Partial<ChatMessageToolCall> = {}) =>
  ({
    name: 'read_artifact',
    durationMs: 5,
    success: true,
    path,
    resultText,
    ...over,
  }) satisfies ChatMessageToolCall;

const toolEntries = (entries: ReturnType<typeof buildToolEvidenceReplay>['entries']) =>
  entries.filter(
    (e): e is { role: 'tool'; content: string; toolCallId: string } => e.role === 'tool',
  );

describe('buildToolEvidenceReplay', () => {
  it('carries plain conversation through unchanged', () => {
    const msgs: ReplaySourceMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    const out = buildToolEvidenceReplay(msgs);
    expect(out.entries).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
    expect(out.replayed).toBe(0);
  });

  it('restores a tool result the old replay dropped', () => {
    const out = buildToolEvidenceReplay([
      { role: 'user', content: 'review batch 10' },
      { role: 'assistant', content: 'reading', toolCalls: [read('pr/226.md', 'PATCH 226')] },
    ]);
    expect(out.replayed).toBe(1);
    const assistant = out.entries[1] as { toolCalls: Array<{ id: string; name: string }> };
    expect(assistant.toolCalls).toHaveLength(1);
    expect(assistant.toolCalls[0]!.name).toBe('read_artifact');
    const tools = toolEntries(out.entries);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.content).toContain('PATCH 226');
    // Pairing: every tool entry answers a call that is actually present.
    expect(tools[0]!.toolCallId).toBe(assistant.toolCalls[0]!.id);
  });

  it('labels a restored result as recovered history, not this turn', () => {
    const out = buildToolEvidenceReplay([
      { role: 'assistant', content: '', toolCalls: [read('pr/226.md', 'PATCH 226')] },
    ]);
    expect(toolEntries(out.entries)[0]!.content).toContain('[recovered from an earlier turn');
    expect(toolEntries(out.entries)[0]!.content).toContain('pr/226.md');
  });

  describe('deduplication — the wild-caught re-read loop', () => {
    // Three restart re-drives produced three passes over the same batch.
    // The model needs the content once, not three times.
    const threePasses: ReplaySourceMessage[] = [
      { role: 'assistant', content: 'pass 1', toolCalls: [read('pr/226.md', 'OLD')] },
      { role: 'user', content: 'restarted' },
      { role: 'assistant', content: 'pass 2', toolCalls: [read('pr/226.md', 'OLDER')] },
      { role: 'user', content: 'restarted' },
      { role: 'assistant', content: 'pass 3', toolCalls: [read('pr/226.md', 'NEWEST')] },
    ];

    it('keeps only the latest read of a path', () => {
      const out = buildToolEvidenceReplay(threePasses);
      expect(out.replayed).toBe(1);
      expect(out.superseded).toBe(2);
      const tools = toolEntries(out.entries);
      expect(tools).toHaveLength(1);
      expect(tools[0]!.content).toContain('NEWEST');
      expect(tools[0]!.content).not.toContain('OLDER');
    });

    it('drops the superseded CALL too, so no result is left unpaired', () => {
      const out = buildToolEvidenceReplay(threePasses);
      const calls = out.entries.flatMap((e) =>
        'toolCalls' in e ? (e.toolCalls as Array<{ id: string }>) : [],
      );
      const answered = new Set(toolEntries(out.entries).map((t) => t.toolCallId));
      expect(calls).toHaveLength(1);
      expect(calls.every((c) => answered.has(c.id))).toBe(true);
      // The superseded assistant turns survive as plain text.
      expect(out.entries[0]).toEqual({ role: 'assistant', content: 'pass 1' });
    });

    it('keeps distinct paths from every pass — union, not last-message-only', () => {
      const out = buildToolEvidenceReplay([
        { role: 'assistant', content: '', toolCalls: [read('a.md', 'A'), read('b.md', 'B')] },
        { role: 'assistant', content: '', toolCalls: [read('a.md', 'A2')] },
      ]);
      const joined = toolEntries(out.entries)
        .map((t) => t.content)
        .join('\n');
      expect(joined).toContain('A2');
      expect(joined).toContain('B');
      expect(joined).not.toMatch(/\bA\b(?!2)/);
    });

    it('never merges two argument-less calls it cannot tell apart', () => {
      const bare = {
        name: 'list_tasks',
        durationMs: 1,
        success: true,
      } satisfies ChatMessageToolCall;
      const out = buildToolEvidenceReplay([
        { role: 'assistant', content: '', toolCalls: [{ ...bare, resultText: 'first' }] },
        { role: 'assistant', content: '', toolCalls: [{ ...bare, resultText: 'second' }] },
      ]);
      expect(out.superseded).toBe(0);
      expect(toolEntries(out.entries)).toHaveLength(2);
    });
  });

  describe('honesty about gaps', () => {
    it('marks a result that was truncated when recorded', () => {
      const out = buildToolEvidenceReplay([
        {
          role: 'assistant',
          content: '',
          toolCalls: [read('pr/226.md', 'half a patch', { resultTruncated: true })],
        },
      ]);
      const body = toolEntries(out.entries)[0]!.content;
      expect(body).toContain('TRUNCATED when recorded');
      expect(body).toContain('not the complete output');
      expect(body).toContain('read_artifact');
    });

    it('replays a failed call as a failure, not as content', () => {
      const out = buildToolEvidenceReplay([
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              name: 'read_artifact',
              durationMs: 2,
              success: false,
              path: 'x.md',
              errorMessage: 'ENOENT',
            },
          ],
        },
      ]);
      expect(toolEntries(out.entries)[0]!.content).toContain('[this call failed] ENOENT');
    });

    it('names what to re-read when a result is dropped for budget', () => {
      const out = buildToolEvidenceReplay(
        [
          { role: 'assistant', content: '', toolCalls: [read('old.md', 'x'.repeat(500))] },
          { role: 'assistant', content: '', toolCalls: [read('new.md', 'y'.repeat(500))] },
        ],
        600,
      );
      const joined = toolEntries(out.entries)
        .map((t) => t.content)
        .join('\n');
      // Most recent survives; the older one degrades to an actionable marker.
      expect(joined).toContain('y'.repeat(500));
      expect(joined).toContain('result not replayed');
      expect(joined).toContain('old.md');
      expect(out.budgetDropped).toBe(1);
      expect(out.replayed).toBe(1);
    });

    it('always funds at least one result, even past the budget', () => {
      const out = buildToolEvidenceReplay(
        [{ role: 'assistant', content: '', toolCalls: [read('big.md', 'z'.repeat(5000))] }],
        100,
      );
      expect(out.replayed).toBe(1);
      expect(toolEntries(out.entries)[0]!.content).toContain('z'.repeat(5000));
    });

    it('keeps a budget-dropped call paired so the template stays valid', () => {
      const out = buildToolEvidenceReplay(
        [
          { role: 'assistant', content: '', toolCalls: [read('old.md', 'x'.repeat(500))] },
          { role: 'assistant', content: '', toolCalls: [read('new.md', 'y'.repeat(500))] },
        ],
        600,
      );
      const calls = out.entries.flatMap((e) =>
        'toolCalls' in e ? (e.toolCalls as Array<{ id: string }>) : [],
      );
      const answered = new Set(toolEntries(out.entries).map((t) => t.toolCallId));
      expect(calls).toHaveLength(2);
      expect(calls.every((c) => answered.has(c.id))).toBe(true);
    });
  });

  it('reconstructs only arguments it can represent as real JSON', () => {
    const out = buildToolEvidenceReplay([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          read('pr/226.md', 'A', { argsFull: 'path: pr/226.md (human text, not JSON)' }),
          {
            name: 'read_files',
            durationMs: 1,
            success: true,
            paths: ['a.ts', 'b.ts'],
            resultText: 'B',
          },
          {
            name: 'search',
            durationMs: 1,
            success: true,
            argsSummary: 'query: foo',
            resultText: 'C',
          },
        ],
      },
    ]);
    const calls = out.entries.flatMap((e) =>
      'toolCalls' in e ? (e.toolCalls as Array<{ name: string; arguments: string }>) : [],
    );
    expect(JSON.parse(calls[0]!.arguments)).toEqual({ path: 'pr/226.md' });
    expect(JSON.parse(calls[1]!.arguments)).toEqual({ paths: ['a.ts', 'b.ts'] });
    // No structured field to reconstruct — emit valid empty args rather
    // than passing human-rendered text off as an arguments payload.
    expect(JSON.parse(calls[2]!.arguments)).toEqual({});
    for (const c of calls) expect(() => JSON.parse(c.arguments)).not.toThrow();
  });

  it('restores the full wild-caught batch inside the default budget', () => {
    // 25 records read three times over, ~2.3 KB each — the shape of the
    // koray/gezel-45 session. Deduplicates to 25 results.
    const pass = (tag: string): ChatMessageToolCall[] =>
      Array.from({ length: 25 }, (_, i) =>
        read(`pr-42/${226 + i}.md`, `${tag}-${'p'.repeat(2300)}`),
      );
    const out = buildToolEvidenceReplay([
      { role: 'assistant', content: '', toolCalls: pass('one') },
      { role: 'assistant', content: '', toolCalls: pass('two') },
      { role: 'assistant', content: '', toolCalls: pass('three') },
    ]);
    expect(out.replayed).toBe(25);
    expect(out.superseded).toBe(50);
    expect(out.budgetDropped).toBe(0);
    expect(out.chars).toBeLessThan(60_000);
  });
});

describe('toolEvidenceBudgetChars', () => {
  it('keeps the legacy floor when the window is unknown', () => {
    // Cloud/CLI providers that do not report a window must not regress.
    expect(toolEvidenceBudgetChars(undefined)).toBe(DEFAULT_TOOL_EVIDENCE_BUDGET_CHARS);
    expect(toolEvidenceBudgetChars(null)).toBe(DEFAULT_TOOL_EVIDENCE_BUDGET_CHARS);
    expect(toolEvidenceBudgetChars(0)).toBe(DEFAULT_TOOL_EVIDENCE_BUDGET_CHARS);
    expect(toolEvidenceBudgetChars(Number.NaN)).toBe(DEFAULT_TOOL_EVIDENCE_BUDGET_CHARS);
  });

  it('never drops below the floor for a small window', () => {
    expect(toolEvidenceBudgetChars(8_192)).toBe(DEFAULT_TOOL_EVIDENCE_BUDGET_CHARS);
  });

  it('grows with the window so long-context sessions stop starving', () => {
    // The wild-caught loop: batch 9 deduplicated to ~132 KB and was capped at
    // 60 KB every rebuild on a model whose 84k-token prompts fit fine.
    const budget = toolEvidenceBudgetChars(98_304);
    expect(budget).toBeGreaterThan(132_000);
  });

  it('caps so a huge window does not volunteer everything', () => {
    expect(toolEvidenceBudgetChars(1_000_000)).toBeLessThanOrEqual(600_000);
  });

  it('is monotonic in the window size', () => {
    const a = toolEvidenceBudgetChars(32_768);
    const b = toolEvidenceBudgetChars(131_072);
    expect(b).toBeGreaterThanOrEqual(a);
  });
});
