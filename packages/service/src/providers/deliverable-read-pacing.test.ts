import { describe, expect, it } from 'vitest';
import { DeliverableReadPaceTracker } from './deliverable-read-pacing.js';
import { TurnAbortError } from './turn-abort-error.js';

describe('DeliverableReadPaceTracker', () => {
  it('only enables for explicit file-deliverable turns', () => {
    expect(DeliverableReadPaceTracker.fromUserText('Please review this repo.')).toBeNull();
    expect(
      DeliverableReadPaceTracker.fromUserText(
        '[Deliverable expected as an IMAGE FILE at `logo.png`. Use generate_image.]',
      ),
    ).toBeNull();
    expect(
      DeliverableReadPaceTracker.fromUserText(
        '[Deliverable expected as a FILE at `review.md`. Your first assistant action should be writeFile.]',
      ),
    ).toBeInstanceOf(DeliverableReadPaceTracker);
  });

  it('warns then aborts after too many read-only calls without a write', () => {
    const tracker = new DeliverableReadPaceTracker({
      targetPath: 'review.md',
      softWarningAt: 2,
      hardAbortAt: 3,
    });

    expect(tracker.recordCall('readFile', 'package').shouldAbort).toBe(false);

    const warned = tracker.recordCall('readdir', 'src');
    expect(warned.shouldAbort).toBe(false);
    expect(warned.output).toContain('writeFile({ path: "review.md"');

    const aborted = tracker.recordCall('readFile', 'index');
    expect(aborted.shouldAbort).toBe(true);
    expect(tracker.buildAbortMessage('llama.cpp')).toContain('`review.md`');
  });

  it('defaults to warning on the fifth read and aborting on the sixth', () => {
    const tracker = DeliverableReadPaceTracker.fromUserText(
      '[Deliverable expected as a FILE at `review.md`. Read source, then writeFile.]',
    );
    expect(tracker).toBeInstanceOf(DeliverableReadPaceTracker);

    for (let i = 1; i <= 4; i++) {
      const result = tracker!.recordCall('readFile', `file-${i}`);
      expect(result.shouldAbort).toBe(false);
      expect(result.output).not.toContain('near the read budget');
    }

    const warned = tracker!.recordCall('readFile', 'file-5');
    expect(warned.shouldAbort).toBe(false);
    expect(warned.output).toContain('near the read budget');

    const aborted = tracker!.recordCall('readFile', 'file-6');
    expect(aborted.shouldAbort).toBe(true);
    expect(aborted.output).toContain('Read budget exhausted');
  });

  it('truncates the hard-abort read output before queuing the write nudge', () => {
    const tracker = new DeliverableReadPaceTracker({
      targetPath: 'review.md',
      softWarningAt: 1,
      hardAbortAt: 1,
    });

    const aborted = tracker.recordCall('readFile', 'x'.repeat(20_000));
    expect(aborted.shouldAbort).toBe(true);
    expect(aborted.output.length).toBeLessThan(9_000);
    expect(aborted.output).toContain('Tool output truncated at 8000 characters');
    expect(aborted.output).toContain('Read budget exhausted');
  });

  it('stops counting once a write lands', () => {
    const tracker = new DeliverableReadPaceTracker({
      targetPath: 'index.html',
      softWarningAt: 1,
      hardAbortAt: 2,
    });

    expect(tracker.recordCall('readFile', 'a').output).toContain('writeFile');
    expect(tracker.recordCall('writeFile', 'wrote').shouldAbort).toBe(false);
    expect(tracker.recordCall('readFile', 'b')).toEqual({
      output: 'b',
      shouldAbort: false,
      readCount: 1,
    });
  });

  it('buildAbort splits the model corrective from a plain user summary', () => {
    const tracker = new DeliverableReadPaceTracker({
      targetPath: 'review.md',
      softWarningAt: 1,
      hardAbortAt: 1,
    });
    tracker.recordCall('readFile', 'x');
    const err = tracker.buildAbort('llama.cpp');
    expect(err).toBeInstanceOf(TurnAbortError);
    // model-facing keeps the label + the writeFile imperative
    expect(err.message).toContain('[llama.cpp]');
    expect(err.message).toContain('writeFile');
    // user-facing drops the label and the imperative, keeps the path hint
    expect(err.userMessage).not.toContain('[llama.cpp]');
    expect(err.userMessage).not.toMatch(/your next message/i);
    expect(err.userMessage).toContain('review.md');
  });
});
