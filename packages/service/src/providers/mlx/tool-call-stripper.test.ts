import { describe, expect, it } from 'vitest';
import { LeakyToolCallStripper } from './tool-call-stripper.js';

describe('LeakyToolCallStripper', () => {
  it('passes plain text through unchanged when chunked all at once', () => {
    const s = new LeakyToolCallStripper();
    expect(s.push('Hello world.')).toBe('Hello world.');
    expect(s.flush()).toBe('');
    expect(s.getStrippedBodies()).toEqual([]);
  });

  it('strips a complete tool-call marker delivered in one chunk', () => {
    const s = new LeakyToolCallStripper();
    const got = s.push('Sure.<|tool_call|>call:foo{a:1}<tool_call|>Done.') + s.flush();
    expect(got).toBe('Sure.Done.');
    expect(s.getStrippedBodies()).toEqual(['call:foo{a:1}']);
  });

  it('handles the closing tag both as <tool_call|> and </tool_call|>', () => {
    const a = new LeakyToolCallStripper();
    expect(a.push('a<|tool_call|>x</tool_call|>b') + a.flush()).toBe('ab');
    const b = new LeakyToolCallStripper();
    expect(b.push('a<|tool_call|>x<tool_call|>b') + b.flush()).toBe('ab');
  });

  it('also accepts the no-pipe close variants <tool_call> / </tool_call>', () => {
    const a = new LeakyToolCallStripper();
    expect(a.push('a<|tool_call|>x</tool_call>b') + a.flush()).toBe('ab');
    const b = new LeakyToolCallStripper();
    expect(b.push('a<|tool_call|>x<tool_call>b') + b.flush()).toBe('ab');
  });

  it('strips the short-form open <|tool_call> (no trailing |>)', () => {
    // The Gemma 4 E4B variant from the wild: open omits `|>`, close
    // keeps it. This is exactly the leak that made the Meester appear
    // stuck — the canonical-only matcher missed it.
    const s = new LeakyToolCallStripper();
    const body = 'call:browser_navigate{url:<|"|>https://www.weather.com/ */}';
    const got = s.push(`Going.<|tool_call>${body}<tool_call|> Then more.`) + s.flush();
    expect(got).toBe('Going. Then more.');
    expect(s.getStrippedBodies()).toEqual([body]);
  });

  it('strips a marker split across chunk boundaries (open token mid-split)', () => {
    const s = new LeakyToolCallStripper();
    let out = '';
    out += s.push('Sure. <|to');
    expect(out).toBe('Sure. ');
    out += s.push('ol_call|>call{stuff}<tool_call|> Done.');
    out += s.flush();
    expect(out).toBe('Sure.  Done.');
    expect(s.getStrippedBodies()).toEqual(['call{stuff}']);
  });

  it('strips a marker split across chunk boundaries (close mid-split)', () => {
    const s = new LeakyToolCallStripper();
    let out = '';
    out += s.push('Plan: <|tool_call|>call{a}<tool_');
    out += s.push('call|> after.');
    out += s.flush();
    expect(out).toBe('Plan:  after.');
    expect(s.getStrippedBodies()).toEqual(['call{a}']);
  });

  it('captures the body of an unclosed marker on flush (model stopped early)', () => {
    const s = new LeakyToolCallStripper();
    let out = '';
    out += s.push('Before. <|tool_call|>call:foo{x:1} (then nothing)');
    out += s.flush();
    expect(out).toBe('Before. ');
    // Body still captured even though the close never arrived — caller
    // can attempt repair on whatever the model managed to write.
    expect(s.getStrippedBodies()).toEqual(['call:foo{x:1} (then nothing)']);
  });

  it('handles multiple markers in one stream', () => {
    const s = new LeakyToolCallStripper();
    const got = s.push('1<|tool_call|>a<tool_call|>2<|tool_call|>b<tool_call|>3') + s.flush();
    expect(got).toBe('123');
    expect(s.getStrippedBodies()).toEqual(['a', 'b']);
  });

  it('emits up to the last `<` when the tail could be a marker prefix', () => {
    const s = new LeakyToolCallStripper();
    expect(s.push('hello <')).toBe('hello ');
    expect(s.push('a world')).toBe('<a world');
    expect(s.flush()).toBe('');
  });

  it('does not strip text containing < that is not a marker', () => {
    const s = new LeakyToolCallStripper();
    const got = s.push('a < b and c < d') + s.flush();
    expect(got).toBe('a < b and c < d');
  });

  it("preserves embedded special-token noise inside marker body (it's all dropped anyway)", () => {
    const s = new LeakyToolCallStripper();
    const got = s.push('go<|tool_call|>call{url:<|"|>https://w.com */}<tool_call|>go') + s.flush();
    expect(got).toBe('gogo');
    expect(s.getStrippedBodies()).toEqual(['call{url:<|"|>https://w.com */}']);
  });

  describe('getEosFlushedBodyIndices — Layer 3 truncation signal', () => {
    it('marks an unclosed-on-flush body as EOS-flushed', () => {
      const s = new LeakyToolCallStripper();
      s.push('Before. <|tool_call|>call:foo{x:1} (then nothing)');
      s.flush();
      expect(s.getStrippedBodies()).toHaveLength(1);
      expect(s.getEosFlushedBodyIndices().has(0)).toBe(true);
    });

    it('leaves a properly-closed body unmarked', () => {
      const s = new LeakyToolCallStripper();
      s.push('a<|tool_call|>call{x:1}<tool_call|>b');
      s.flush();
      expect(s.getStrippedBodies()).toHaveLength(1);
      expect(s.getEosFlushedBodyIndices().has(0)).toBe(false);
    });

    it('marks only the unclosed body when mixed with completed ones', () => {
      const s = new LeakyToolCallStripper();
      s.push('1<|tool_call|>complete{a}<tool_call|>2<|tool_call|>truncated{b: <|"|>missing close');
      s.flush();
      expect(s.getStrippedBodies()).toHaveLength(2);
      expect(s.getEosFlushedBodyIndices().has(0)).toBe(false);
      expect(s.getEosFlushedBodyIndices().has(1)).toBe(true);
    });
  });
});
