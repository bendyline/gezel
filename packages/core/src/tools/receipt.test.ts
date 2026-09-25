import { describe, expect, it } from 'vitest';
import {
  buildToolReceipt,
  humanizeToolCall,
  renderFullToolArgs,
  summarizeToolArgs,
  summarizeToolResult,
} from './receipt.js';

describe('humanizeToolCall — non-nerdy summaries', () => {
  it('renders a message_gezel handoff as a sentence with target, gist, and file', () => {
    const out = humanizeToolCall('message_gezel', {
      gezel: 'Freja',
      message: 'Update the game loop in workspace/index.html: change the penalty to 50.',
      expectedDeliverable: '{"filePath": "workspace/index.html", "kind": "file"}',
    });
    expect(out).toContain('→ Freja');
    expect(out).toContain('Update the game loop');
    expect(out).toContain('file: workspace/index.html');
    // No JSON-y key:value noise.
    expect(out).not.toContain('expectedDeliverable');
    expect(out).not.toContain('{');
  });

  it('handles expectedDeliverable as a real object too (not just a JSON string)', () => {
    const out = humanizeToolCall('message_gezel', {
      gezel: 'Freja',
      message: 'go',
      expectedDeliverable: { filePath: 'workspace/index.html', kind: 'file' },
    });
    expect(out).toContain('file: workspace/index.html');
  });

  it('covers the common task + file tools with friendly phrasing', () => {
    expect(
      humanizeToolCall('set_task_status', { ref: 'space-shooter-arcade/1', status: 'complete' }),
    ).toBe('Marked space-shooter-arcade/1 complete');
    expect(humanizeToolCall('create_task', { title: 'Add high-score table' })).toBe(
      'Created task “Add high-score table”',
    );
    expect(humanizeToolCall('write_file', { path: 'workspace/index.html' })).toBe(
      'Wrote workspace/index.html',
    );
    expect(humanizeToolCall('read_file', { path: 'workspace/index.html' })).toBe(
      'Read workspace/index.html',
    );
    expect(humanizeToolCall('ensure_gezel', { jobTitle: 'Developer' })).toBe(
      'Lined up a Developer',
    );
    expect(humanizeToolCall('invoke_craftbook', { craftbookId: 'powerpoint-deck' })).toBe(
      'Started powerpoint-deck',
    );
  });

  it('returns undefined for unknown tools so the caller falls back to the key:value summary', () => {
    expect(humanizeToolCall('some_third_party_tool', { foo: 'bar' })).toBeUndefined();
    // The fallback still works:
    expect(summarizeToolArgs({ foo: 'bar' })).toBe('foo: "bar"');
  });
});

describe('renderFullToolArgs — complete, copyable blob', () => {
  it('shows every field in full, with long/multiline values on their own block', () => {
    const body = 'line one\nline two\nline three';
    const out = renderFullToolArgs({ gezel: 'Freja', message: body });
    expect(out).toContain('gezel: Freja');
    expect(out).toContain(`message:\n${body}`); // full, untruncated, multiline
  });

  it('does not drop bulky fields the way the summary does', () => {
    const content = 'x'.repeat(500);
    const full = renderFullToolArgs({ path: 'a.html', content });
    expect(full).toContain(content); // kept in full
    const summary = summarizeToolArgs({ path: 'a.html', content });
    expect(summary).not.toContain(content); // summary omits it
  });

  it('caps very large blobs with a truncation marker', () => {
    const huge = 'y'.repeat(150_000);
    const out = renderFullToolArgs({ content: huge })!;
    expect(out.length).toBeLessThan(150_000);
    expect(out).toContain('… (truncated)');
  });

  it('returns undefined for empty args', () => {
    expect(renderFullToolArgs(undefined)).toBeUndefined();
    expect(renderFullToolArgs({})).toBeUndefined();
  });
});

describe('summarizeToolResult — bounded response details', () => {
  it('preserves a short response exactly', () => {
    expect(summarizeToolResult('matched craftbook: presentations/powerpoint')).toEqual({
      text: 'matched craftbook: presentations/powerpoint',
      truncated: false,
    });
  });

  it('summarizes a long response with counts plus beginning and end', () => {
    const result = `FIRST\n${'middle\n'.repeat(900)}LAST`;
    const summary = summarizeToolResult(result)!;
    expect(summary.truncated).toBe(true);
    expect(summary.text).toContain('Long response:');
    expect(summary.text).toContain('characters omitted');
    expect(summary.text).toContain('FIRST');
    expect(summary.text).toContain('LAST');
    expect(summary.text.length).toBeLessThan(result.length);
  });

  it('can retain task evidence up to a caller-provided replay budget', () => {
    const result = `FIRST\n${'patch line\n'.repeat(1_000)}LAST`;
    expect(result.length).toBeGreaterThan(4_000);
    expect(summarizeToolResult(result, 60_000)).toEqual({
      text: result,
      truncated: false,
    });
  });

  it('omits empty responses', () => {
    expect(summarizeToolResult(undefined)).toBeUndefined();
    expect(summarizeToolResult('   \n')).toBeUndefined();
  });
});

describe('buildToolReceipt', () => {
  it('fills the persisted fields the same way for every host', () => {
    const receipt = buildToolReceipt({
      name: 'write_file',
      args: { path: 'notes.md', content: 'x'.repeat(500) },
      startedAtMs: Date.UTC(2026, 8, 22, 10, 0, 0),
      durationMs: 12,
      success: true,
      resultText: 'y'.repeat(10_000),
    });
    expect(receipt.at).toBe('2026-09-22T10:00:00.000Z');
    expect(receipt.argsSummary).toBe('Wrote notes.md');
    expect(receipt.argsFull).toContain('content:');
    expect(receipt.resultTruncated).toBe(true);
    expect(receipt.resultText).toContain('characters omitted');
    expect(receipt).not.toHaveProperty('errorMessage');
    const empty = buildToolReceipt({
      name: 'x',
      startedAtMs: 0,
      durationMs: 0,
      success: false,
      errorMessage: 'boom',
    });
    expect(empty.errorMessage).toBe('boom');
    expect(empty).not.toHaveProperty('resultText');
    expect(empty).not.toHaveProperty('resultTruncated');
  });
});
