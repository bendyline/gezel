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
        '[Deliverable expected as a FILE at `review.md`. Your first assistant action should be write_file.]',
      ),
    ).toBeInstanceOf(DeliverableReadPaceTracker);
  });

  it('warns then aborts after too many read-only calls without a write', () => {
    const tracker = new DeliverableReadPaceTracker({
      targetPath: 'review.md',
      softWarningAt: 2,
      hardAbortAt: 3,
    });

    expect(tracker.recordCall('read_file', 'package').shouldAbort).toBe(false);

    const warned = tracker.recordCall('list_dir', 'src');
    expect(warned.shouldAbort).toBe(false);
    expect(warned.output).toContain('write_file({ path: "review.md"');

    const aborted = tracker.recordCall('read_file', 'index');
    expect(aborted.shouldAbort).toBe(true);
    expect(tracker.buildAbortMessage('llama.cpp')).toContain('`review.md`');
  });

  it('counts both the canonical grep_files name and its search_files compatibility alias', () => {
    const tracker = new DeliverableReadPaceTracker({
      targetPath: 'review.md',
      softWarningAt: 2,
      hardAbortAt: 3,
    });

    expect(tracker.recordCall('grep_files', 'first').readCount).toBe(1);
    expect(tracker.recordCall('search_files', 'second')).toMatchObject({
      readCount: 2,
      shouldAbort: false,
    });
    expect(tracker.recordCall('search_files', 'third').shouldAbort).toBe(true);
  });

  it('counts both read_files and its read_multiple_files compatibility alias', () => {
    const tracker = new DeliverableReadPaceTracker({
      targetPath: 'review.md',
      softWarningAt: 2,
      hardAbortAt: 3,
    });

    expect(tracker.recordCall('read_files', 'first').readCount).toBe(1);
    expect(tracker.recordCall('read_multiple_files', 'second')).toMatchObject({
      readCount: 2,
      shouldAbort: false,
    });
    expect(tracker.recordCall('read_multiple_files', 'third').shouldAbort).toBe(true);
  });

  it('defaults to warning on the fifth read and aborting on the sixth', () => {
    const tracker = DeliverableReadPaceTracker.fromUserText(
      '[Deliverable expected as a FILE at `review.md`. Read source, then write_file.]',
    );
    expect(tracker).toBeInstanceOf(DeliverableReadPaceTracker);

    for (let i = 1; i <= 4; i++) {
      const result = tracker!.recordCall('read_file', `file-${i}`);
      expect(result.shouldAbort).toBe(false);
      expect(result.output).not.toContain('near the read budget');
    }

    const warned = tracker!.recordCall('read_file', 'file-5');
    expect(warned.shouldAbort).toBe(false);
    expect(warned.output).toContain('near the read budget');

    const aborted = tracker!.recordCall('read_file', 'file-6');
    expect(aborted.shouldAbort).toBe(true);
    expect(aborted.output).toContain('Read budget exhausted');
  });

  it('truncates the hard-abort read output before queuing the write nudge', () => {
    const tracker = new DeliverableReadPaceTracker({
      targetPath: 'review.md',
      softWarningAt: 1,
      hardAbortAt: 1,
    });

    const aborted = tracker.recordCall('read_file', 'x'.repeat(20_000));
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

    expect(tracker.recordCall('read_file', 'a').output).toContain('write_file');
    expect(tracker.recordCall('write_file', 'wrote').shouldAbort).toBe(false);
    expect(tracker.recordCall('read_file', 'b')).toEqual({
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
    tracker.recordCall('read_file', 'x');
    const err = tracker.buildAbort('llama.cpp');
    expect(err).toBeInstanceOf(TurnAbortError);
    // model-facing keeps the label + the write_file imperative
    expect(err.message).toContain('[llama.cpp]');
    expect(err.message).toContain('write_file');
    // user-facing drops the label and the imperative, keeps the path hint
    expect(err.userMessage).not.toContain('[llama.cpp]');
    expect(err.userMessage).not.toMatch(/your next message/i);
    expect(err.userMessage).toContain('review.md');
  });
});
