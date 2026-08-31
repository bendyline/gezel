import { describe, expect, it } from 'vitest';

import { MlxProvider } from './provider.js';
import { classifyMlxFatalErrorLine } from './stdout-parser.js';

/**
 * The stdout classifier reads any `SomeError: <message>` leaf line as proof
 * the engine is dead, and the provider answers by tearing the process down.
 * That is right during startup, which is what it was written for — and wrong
 * once the engine is serving, where the sidecar prints the same line shape
 * from handlers that already CAUGHT the failure and answered the one request
 * it belonged to.
 *
 * Wild-caught: a speculative-decode wave asked Metal for a 181 GB buffer on a
 * 61.5K-token prompt. Python contained it, logged `[spec] wave failed`, and
 * returned an error to that request. The traceback's leaf line then reached
 * this classifier, which SIGKILLed a 27B that had been up three minutes —
 * killing an unrelated session mid-prefill with it, and reporting the whole
 * thing as "engine failed to start".
 */
const READY_LINE = 'INFO:     Application startup complete.';
const STARTING_LINE = 'INFO:     Started server process [56538]';
const OOM_LINE =
  'RuntimeError: [metal::malloc] Attempting to allocate 181683817392 bytes ' +
  'which is greater than the maximum allowed buffer size of 86586540032 bytes.';

function provider(): MlxProvider {
  // External-baseUrl mode leaves `supervisor` undefined, so
  // `handleFatalError`'s teardown is a no-op and the test observes the
  // decision itself (which bucket the line landed in) rather than a process
  // kill it would have to stub.
  return new MlxProvider({ baseUrl: 'http://127.0.0.1:6229' });
}

describe('MLX engine error scoping', () => {
  it('treats a leaf error line during startup as fatal', () => {
    const p = provider();
    p.onStdoutLine(STARTING_LINE);
    p.onStdoutLine(OOM_LINE);
    expect(p.takeFatalError()?.message).toContain('metal::malloc');
    expect(p.takeRuntimeError()).toBeNull();
  });

  it('does not kill a serving engine for a contained error', () => {
    const p = provider();
    p.onStdoutLine(STARTING_LINE);
    p.onStdoutLine(READY_LINE);
    p.onStdoutLine(OOM_LINE);
    // Nothing fatal — the next send must not be short-circuited, and the
    // engine must keep serving every other session on it.
    expect(p.takeFatalError()).toBeNull();
    expect(p.takeRuntimeError()?.message).toContain('metal::malloc');
  });

  it('re-arms startup handling when the engine respawns', () => {
    const p = provider();
    p.onStdoutLine(STARTING_LINE);
    p.onStdoutLine(READY_LINE);
    p.onStdoutLine(OOM_LINE);
    expect(p.takeFatalError()).toBeNull();
    // A fresh child: a boot failure on the new process is fatal again.
    p.onStdoutLine(STARTING_LINE);
    p.onStdoutLine('ImportError: No module named mlx_vlm');
    expect(p.takeFatalError()?.category).toBe('missing-dependency');
  });

  it('clears the serving-time error when a fresh child starts', () => {
    const p = provider();
    p.onStdoutLine(STARTING_LINE);
    p.onStdoutLine(READY_LINE);
    p.onStdoutLine(OOM_LINE);
    p.onStdoutLine(STARTING_LINE);
    expect(p.takeRuntimeError()).toBeNull();
  });

  it('never classifies the sidecar’s tagged traceback lines', () => {
    // Second line of defence, from the Python side: the contained handler
    // tags every traceback line so it cannot match the leaf-line shape even
    // if this scoping regresses.
    expect(classifyMlxFatalErrorLine(`[spec] | ${OOM_LINE}`)).toBeNull();
    expect(classifyMlxFatalErrorLine('[spec] |   File "spec_decode.py", line 553')).toBeNull();
    // The bare line still classifies — the tag is what defuses it.
    expect(classifyMlxFatalErrorLine(OOM_LINE)?.message).toContain('metal::malloc');
  });
});
