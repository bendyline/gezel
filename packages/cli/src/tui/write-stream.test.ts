import { describe, expect, it } from 'vitest';
import {
  appendWriteArgumentChunk,
  createWriteStreamState,
  isStreamedWriteTool,
} from './write-stream.js';

describe('streamed write payloads', () => {
  it('recognizes canonical and camel-case write tool names', () => {
    expect(isStreamedWriteTool('write_file')).toBe(true);
    expect(isStreamedWriteTool('writeArtifact')).toBe(true);
    expect(isStreamedWriteTool('read_file')).toBe(false);
  });

  it('decodes one content field across chunks without exposing other arguments', () => {
    let state = createWriteStreamState('write_file');
    let result = appendWriteArgumentChunk(
      state,
      '{"path":"private/report.md","content":"first\\nsec',
    );
    state = result.state;
    expect(result.text).toBe('first\nsec');

    result = appendWriteArgumentChunk(state, 'ond \\"quote\\" \\u263A"}');
    expect(result.text).toBe('ond "quote" ☺');
    expect(result.state.phase).toBe('done');
  });

  it('finds a task-note text key split across chunks', () => {
    let state = createWriteStreamState('write_task_note');
    const first = appendWriteArgumentChunk(state, '{"ref":"studio/4","te');
    state = first.state;
    const second = appendWriteArgumentChunk(state, 'xt":"mapped the ');
    const third = appendWriteArgumentChunk(second.state, 'risk"}');

    expect(first.text).toBe('');
    expect(second.text + third.text).toBe('mapped the risk');
  });

  it('selects the replacement payload rather than the matched source text', () => {
    const result = appendWriteArgumentChunk(
      createWriteStreamState('replace_in_file'),
      '{"path":"app.ts","find":"old secret","replace":"new value"}',
    );

    expect(result.text).toBe('new value');
  });
});
