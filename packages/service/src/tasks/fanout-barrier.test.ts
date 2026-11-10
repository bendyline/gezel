import type { Task } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  isFanoutShard,
  pausedCrewNote,
  pausesForPausedCrew,
  waitsOnFanoutCrew,
} from './fanout-barrier.js';

const spawnsCraftbook = { id: 'tpl' } as unknown as Task['spawnsCraftbook'];

describe('fanout barrier rules', () => {
  it('holds only the step after a fanout, never the fanout step itself', () => {
    expect(waitsOnFanoutCrew({ spawnsCraftbook }, { spawnFanout: undefined })).toBe(true);
    expect(waitsOnFanoutCrew({ spawnsCraftbook }, { spawnFanout: true })).toBe(false);
    expect(waitsOnFanoutCrew({ spawnsCraftbook: undefined }, {})).toBe(false);
    expect(waitsOnFanoutCrew({ spawnsCraftbook }, undefined)).toBe(false);
  });

  it('never lets a paused scheduled run pause its schedule', () => {
    expect(pausesForPausedCrew({ spawnsCraftbook }, {})).toBe(true);
    expect(
      pausesForPausedCrew({ spawnsCraftbook, cron: { expression: '0 9 * * *' } } as never, {}),
    ).toBe(false);
  });

  it('counts a child as a shard only under the spawn host it names', () => {
    const host = { ref: 'p/1', spawnsCraftbook };
    expect(isFanoutShard({ parentTaskRef: 'p/1' }, host)).toBe(true);
    expect(isFanoutShard({ parentTaskRef: 'p/9' }, host)).toBe(false);
    expect(isFanoutShard({ parentTaskRef: 'p/1' }, { ...host, spawnsCraftbook: undefined })).toBe(
      false,
    );
    expect(
      isFanoutShard({ parentTaskRef: 'p/1' }, {
        ...host,
        cron: { expression: '* * * * *' },
      } as never),
    ).toBe(false);
    expect(isFanoutShard({ parentTaskRef: 'p/1' }, null)).toBe(false);
  });

  it('names every paused part and both ways forward', () => {
    const note = pausedCrewNote('Collect', 'collect', [
      { ref: 'p/4', title: 'Invoice 2026-044' },
      { ref: 'p/5', title: 'Invoice 2026-045' },
    ]);
    expect(note).toContain('2 parts have paused for help');
    expect(note).toContain('- `p/4` "Invoice 2026-044"');
    expect(note).toContain('- `p/5` "Invoice 2026-045"');
    expect(note).toContain('Try again restarts the paused parts');
    expect(note).toContain('cancel it, then choose Try again here');
  });
});
