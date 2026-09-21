import { describe, expect, it } from 'vitest';
import { createThinkSplitter } from './think-splitter.js';

function collect() {
  const thinking: string[] = [];
  const output: string[] = [];
  const splitter = createThinkSplitter({
    onThinking: (t) => thinking.push(t),
    onOutput: (t) => output.push(t),
  });
  return { splitter, thinking: () => thinking.join(''), output: () => output.join('') };
}

describe('createThinkSplitter', () => {
  it('passes tag-free text straight to output', () => {
    const c = collect();
    c.splitter.push('Hello ');
    c.splitter.push('world');
    c.splitter.flush();
    expect(c.output()).toBe('Hello world');
    expect(c.thinking()).toBe('');
  });

  it('routes a closed think block to thinking and the rest to output', () => {
    const c = collect();
    c.splitter.push('<think>plan the rewrite</think>Final text.');
    c.splitter.flush();
    expect(c.thinking()).toBe('plan the rewrite');
    expect(c.output()).toBe('Final text.');
  });

  it('handles a tag split across chunk boundaries', () => {
    const c = collect();
    c.splitter.push('<thi');
    c.splitter.push('nk>inner</th');
    c.splitter.push('ink>after');
    c.splitter.flush();
    expect(c.thinking()).toBe('inner');
    expect(c.output()).toBe('after');
  });

  it('streams the remainder as thinking when the tag never closes', () => {
    const c = collect();
    c.splitter.push('<think>still going');
    c.splitter.push(' and going');
    c.splitter.flush();
    expect(c.thinking()).toBe('still going and going');
    expect(c.output()).toBe('');
  });

  it('supports <reasoning> tags and mixed case', () => {
    const c = collect();
    c.splitter.push('<Reasoning>why</REASONING>done');
    c.splitter.flush();
    expect(c.thinking()).toBe('why');
    expect(c.output()).toBe('done');
  });

  it('emits a bare < that is not a tag prefix', () => {
    const c = collect();
    c.splitter.push('a < b and 1 <2');
    c.splitter.flush();
    expect(c.output()).toBe('a < b and 1 <2');
    expect(c.thinking()).toBe('');
  });

  it('flushes a held-back partial prefix at end of stream', () => {
    const c = collect();
    c.splitter.push('tail<thin');
    c.splitter.flush();
    expect(c.output()).toBe('tail<thin');
  });
});
