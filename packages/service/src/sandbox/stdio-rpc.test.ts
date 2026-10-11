import { describe, expect, it } from 'vitest';
import {
  StdioRpcDemuxer,
  StdioRpcOverflowError,
  stdioRpcInitLine,
  stdioRpcMarker,
} from './stdio-rpc.js';

const nonce = 'abc123';
const marker = stdioRpcMarker(nonce);
const frame = (json: string) => `${marker}${json}\n`;

describe('StdioRpcDemuxer', () => {
  it('passes ordinary output through untouched', () => {
    const demuxer = new StdioRpcDemuxer(nonce);
    expect(demuxer.push('hello\nworld\n')).toEqual({ text: 'hello\nworld\n', frames: [] });
  });

  it('extracts whole frames between lines of output', () => {
    const demuxer = new StdioRpcDemuxer(nonce);
    const result = demuxer.push(`before\n${frame('{"id":1}')}after\n`);
    expect(result).toEqual({ text: 'before\nafter\n', frames: ['{"id":1}'] });
  });

  it('extracts a frame that starts mid-line', () => {
    const demuxer = new StdioRpcDemuxer(nonce);
    const result = demuxer.push(`partial${frame('{"id":2}')}rest\n`);
    expect(result).toEqual({ text: 'partialrest\n', frames: ['{"id":2}'] });
  });

  it('reassembles a frame and a marker split across chunks', () => {
    const demuxer = new StdioRpcDemuxer(nonce);
    const whole = `x${frame('{"id":3,"method":"fs.read"}')}y\n`;
    const seen = { text: '', frames: [] as string[] };
    for (const ch of whole) {
      const { text, frames } = demuxer.push(ch);
      seen.text += text;
      seen.frames.push(...frames);
    }
    expect(seen).toEqual({ text: 'xy\n', frames: ['{"id":3,"method":"fs.read"}'] });
  });

  it('treats a frame with the wrong nonce as printed text', () => {
    const demuxer = new StdioRpcDemuxer(nonce);
    const forged = `${stdioRpcMarker('guessed')}{"id":9,"method":"fs.write"}\n`;
    const { text, frames } = demuxer.push(forged);
    expect(frames).toEqual([]);
    expect(text + demuxer.flush()).toBe(forged);
  });

  it('returns an unfinished frame as text when the script exits', () => {
    const demuxer = new StdioRpcDemuxer(nonce);
    expect(demuxer.push(`${marker}{"id":4`).frames).toEqual([]);
    expect(demuxer.flush()).toBe(`${marker}{"id":4`);
  });

  it('reassembles a large frame arriving in many chunks', () => {
    const demuxer = new StdioRpcDemuxer(nonce);
    const payload = `{"id":5,"params":{"content":"${'x'.repeat(200_000)}"}}`;
    const whole = frame(payload);
    const frames: string[] = [];
    for (let i = 0; i < whole.length; i += 4_096) {
      frames.push(...demuxer.push(whole.slice(i, i + 4_096)).frames);
    }
    expect(frames).toEqual([payload]);
  });

  it('refuses an unfinished frame that grows past the cap, but not plain output', () => {
    const demuxer = new StdioRpcDemuxer(nonce, 1_000);
    expect(demuxer.push('y'.repeat(5_000)).text).toHaveLength(5_000);
    demuxer.push(`${marker}{"id":6,"params":"`);
    expect(() => demuxer.push('z'.repeat(2_000))).toThrow(StdioRpcOverflowError);
  });
});

describe('stdioRpcInitLine', () => {
  it('collapses pretty-printed JSON to one line', () => {
    expect(stdioRpcInitLine('{\n  "runId": "r1"\n}\n')).toBe('{"runId":"r1"}\n');
  });
});
