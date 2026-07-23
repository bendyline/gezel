import { describe, expect, it } from 'vitest';
import { classifyDs4Line } from './stdout-parser.js';

// Fixture lines mirror the exact format strings in the pinned upstream
// (native/engines/ds4/VERSION): server_log() prepends `MMDD HH:MM:SS `,
// the supervisor prepends `[ds4-server] `.

describe('classifyDs4Line', () => {
  it('returns null on unknown lines', () => {
    expect(classifyDs4Line('some random noise')).toBeNull();
    expect(classifyDs4Line('')).toBeNull();
    expect(classifyDs4Line('[ds4-server] ')).toBeNull();
    expect(
      classifyDs4Line('[ds4-server] 0718 14:30:00 ds4-server: accept failed: EINTR'),
    ).toBeNull();
  });

  it('recognizes the listening line as ready', () => {
    const phase = classifyDs4Line(
      '[ds4-server] 0718 14:30:00 ds4-server: listening on http://127.0.0.1:52341',
    );
    expect(phase).toEqual({ phase: 'ready', detail: 'Server ready' });
  });

  it('parses prefill chunk progress with flags present', () => {
    const phase = classifyDs4Line(
      '[ds4-server] 0718 14:32:07 ds4-server: chat ctx=0..7880:7880 TOOLS prefill chunk 512/7880 (6.5%) chunk=39.35 t/s avg=39.35 t/s 13.013s',
    );
    expect(phase?.phase).toBe('prefill');
    expect(phase?.progress).toBeCloseTo(512 / 7880, 5);
    expect(phase?.detail).toBe('Processing prompt (6% · 512 / 7,880 tokens · 39 tok/s)');
  });

  it('parses prefill chunk progress without flags', () => {
    const phase = classifyDs4Line(
      '0718 09:01:44 ds4-server: completion ctx=0..2048:2048 prefill chunk 2048/2048 (100.0%) chunk=41.02 t/s avg=40.11 t/s 51.062s',
    );
    expect(phase?.phase).toBe('prefill');
    expect(phase?.progress).toBe(1);
    expect(phase?.detail).toBe('Processing prompt (100% · 2,048 / 2,048 tokens · 40 tok/s)');
  });

  it('parses tool-checkpoint rebuild progress as a restore label', () => {
    const phase = classifyDs4Line(
      '[ds4-server] 0718 14:40:19 ds4-server: chat ctx=100..7880:7780 RESPPROTO TOOLS tool checkpoint rebuild chunk 3200/7880 (40.6%) chunk=38.90 t/s avg=39.05 t/s 82.4s',
    );
    expect(phase?.phase).toBe('prefill');
    expect(phase?.progress).toBeCloseTo(3200 / 7880, 5);
    expect(phase?.detail).toBe('Restoring session context (41% · 3,200 / 7,880 tokens)');
  });

  it('parses decode progress with sub-10 tok/s kept to one decimal', () => {
    const phase = classifyDs4Line(
      '[ds4-server] 0718 14:35:12 ds4-server: chat ctx=7880..8030:150 gen=150 TOOLS decoding chunk=5.20 t/s avg=5.35 t/s 28.846s',
    );
    expect(phase?.phase).toBe('generating');
    expect(phase?.progress).toBeUndefined();
    expect(phase?.detail).toBe('150 tokens · 5.3 tok/s');
  });

  it('parses decode progress with THINKING flag and large counts', () => {
    const phase = classifyDs4Line(
      '0718 15:02:33 ds4-server: chat ctx=7880..9130:1250 gen=1250 TOOLS THINKING decoding chunk=4.98 t/s avg=5.02 t/s 249.0s',
    );
    expect(phase?.phase).toBe('generating');
    expect(phase?.detail).toBe('1,250 tokens · 5.0 tok/s');
  });

  it('recognizes the tensor-mapping ticker without bufferBytes', () => {
    const phase = classifyDs4Line(
      '[ds4-server] ds4: metal prepared model tensor mappings 12.50 GiB',
    );
    expect(phase?.phase).toBe('loading_model');
    expect(phase?.detail).toBe('Mapping model tensors (12.50 GiB)');
    // Cumulative ticker — accumulating each tick would inflate the RAM
    // total, so no bufferBytes on this pattern.
    expect(phase?.bufferBytes).toBeUndefined();
  });

  it('recognizes page warming with a one-shot bufferBytes figure', () => {
    const phase = classifyDs4Line('[ds4-server] ds4: warming mapped tensor pages: 81.20 GiB');
    expect(phase?.phase).toBe('loading_model');
    expect(phase?.detail).toBe('Warming model pages (81.20 GiB)');
    expect(phase?.bufferBytes).toBe(Math.round(81.2 * 1024 * 1024 * 1024));
  });

  it('recognizes the warm-complete line', () => {
    const phase = classifyDs4Line(
      '[ds4-server] ds4: warmed tensor pages in 93.001s (checksum=1234567)',
    );
    expect(phase?.phase).toBe('loading_model');
    expect(phase?.detail).toBe('Warmed model pages in 93s');
  });

  it('parses core streaming-prefill token meters (\\r repaint lines)', () => {
    const phase = classifyDs4Line('[ds4-server] ds4: gpu streaming prefill token 512/7880');
    expect(phase?.phase).toBe('prefill');
    expect(phase?.progress).toBeCloseTo(512 / 7880, 5);
    expect(phase?.detail).toBe('Processing prompt (6% · 512 / 7,880 tokens)');
  });

  it('parses core prefill layer meters', () => {
    expect(classifyDs4Line('[ds4-server] ds4: prefill layer 12/61')).toEqual({
      phase: 'prefill',
      detail: 'Prefill layer 12 / 61',
      progress: 12 / 61,
    });
    expect(classifyDs4Line('ds4: gpu prefill layer 61/61')?.progress).toBe(1);
  });

  it('rejects malformed counts instead of emitting garbage progress', () => {
    expect(
      classifyDs4Line(
        '0718 14:32:07 ds4-server: chat ctx=0..0:0 prefill chunk 5/0 (0.0%) chunk=0.00 t/s avg=0.00 t/s 0.001s',
      ),
    ).toBeNull();
    expect(classifyDs4Line('ds4: gpu streaming prefill token 9/0')).toBeNull();
  });

  it('does not match llama-server lines (wrong engine)', () => {
    expect(
      classifyDs4Line(
        '[llama-server] slot update_slots: id 3 | task 0 | prompt processing progress, n_tokens = 2048, progress = 0.146474',
      ),
    ).toBeNull();
    expect(
      classifyDs4Line('[llama-server] main: server is listening on 127.0.0.1:8080'),
    ).toBeNull();
  });
});
