import { describe, expect, it } from 'vitest';
import { collapseDuplicateToolCalls } from './duplicate-tool-calls.js';

const call = (name: string, args: unknown) => ({
  function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});

describe('collapseDuplicateToolCalls', () => {
  it('collapses the stutter that aborted three PPTX trials', () => {
    // One generation, one set of arguments, eight copies — then
    // `abort-repeat-loop tool=read_task_notes sameArgsCalls=5`.
    const stutter = Array.from({ length: 8 }, () => call('read_task_notes', { ref: 'default/2' }));
    const result = collapseDuplicateToolCalls(stutter);
    expect(result.calls).toHaveLength(1);
    expect(result.dropped).toEqual([{ name: 'read_task_notes', count: 7 }]);
  });

  it('keeps a legitimate batch that repeats a NAME with different arguments', () => {
    // Seen in the same run: read_task_notes, list_dir, list_artifacts,
    // read_file x3 (three different paths), read_document, stat x2.
    const batch = [
      call('read_file', { path: 'a.md' }),
      call('read_file', { path: 'b.md' }),
      call('read_file', { path: 'c.md' }),
      call('stat', { path: 'a.md' }),
      call('stat', { path: 'b.md' }),
    ];
    expect(collapseDuplicateToolCalls(batch).calls).toHaveLength(5);
  });

  it('preserves order and keeps the first copy', () => {
    const result = collapseDuplicateToolCalls([
      call('read_file', { path: 'a.md' }),
      call('list_dir', { path: '.' }),
      call('read_file', { path: 'a.md' }),
      call('stat', { path: 'z' }),
    ]);
    expect(result.calls.map((c) => c.function.name)).toEqual(['read_file', 'list_dir', 'stat']);
  });

  it('treats key order in the arguments as insignificant', () => {
    const result = collapseDuplicateToolCalls([
      call('read_file', '{"path":"a.md","limit":10}'),
      call('read_file', '{"limit":10,"path":"a.md"}'),
    ]);
    expect(result.calls).toHaveLength(1);
  });

  it('never collapses an accumulative tool — two appends are two appends', () => {
    const twice = [
      call('append_to_file', { path: 'log.md', content: 'line\n' }),
      call('append_to_file', { path: 'log.md', content: 'line\n' }),
    ];
    expect(collapseDuplicateToolCalls(twice).calls).toHaveLength(2);
    expect(collapseDuplicateToolCalls(twice).dropped).toEqual([]);
  });

  it('collapses a whole-file write, where the repeat is indistinguishable', () => {
    const twice = [
      call('write_file', { path: 'deck.md', content: '# A' }),
      call('write_file', { path: 'deck.md', content: '# A' }),
    ];
    expect(collapseDuplicateToolCalls(twice).calls).toHaveLength(1);
  });

  it('does not collapse a rewrite of the same file with different content', () => {
    const edits = [
      call('write_file', { path: 'deck.md', content: '# A' }),
      call('write_file', { path: 'deck.md', content: '# B' }),
    ];
    expect(collapseDuplicateToolCalls(edits).calls).toHaveLength(2);
  });

  it('compares unparseable arguments literally rather than throwing', () => {
    const broken = [call('read_file', '{"path": '), call('read_file', '{"path": ')];
    expect(collapseDuplicateToolCalls(broken).calls).toHaveLength(1);
  });

  it('returns the input untouched when there is nothing to collapse', () => {
    const one = [call('read_file', { path: 'a' })];
    const result = collapseDuplicateToolCalls(one);
    expect(result.calls).toBe(one);
    expect(result.dropped).toEqual([]);
  });
});
