import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatMovieBytes,
  formatMovieOffset,
  formatToolCallScene,
  sceneActorLabel,
  sceneKindLabel,
} from './components/movie.ts';

describe('eval viewer movie formatting', () => {
  it('formats offsets at timeline boundaries', () => {
    assert.equal(formatMovieOffset(Number.NaN), '—');
    assert.equal(formatMovieOffset(-1), '—');
    assert.equal(formatMovieOffset(0), 't+0s');
    assert.equal(formatMovieOffset(59_999), 't+59s');
    assert.equal(formatMovieOffset(60_000), 't+1m00s');
    assert.equal(formatMovieOffset(3_661_000), 't+61m01s');
  });

  it('formats recording byte counts at each unit boundary', () => {
    assert.equal(formatMovieBytes(512), '512 B');
    assert.equal(formatMovieBytes(1536), '2 KB');
    assert.equal(formatMovieBytes(1_572_864), '1.5 MB');
  });

  it('maps known scene kinds and preserves newer unknown kinds', () => {
    assert.equal(sceneKindLabel('user-prompt'), 'prompt');
    assert.equal(sceneKindLabel('tool-call'), 'tool');
    assert.equal(sceneKindLabel('new-runner-scene'), 'new-runner-scene');
  });

  it('labels ordinary and delegated scene actors', () => {
    const nameOf = (id) => ({ scout: 'Scout', maker: 'Maker' })[id] ?? '—';
    assert.equal(sceneActorLabel({ kind: 'reply', at: '', actorId: 'scout' }, nameOf), 'Scout');
    assert.equal(
      sceneActorLabel(
        {
          kind: 'delegation',
          at: '',
          actorId: 'scout',
          toActorId: 'maker',
          delegationKind: 'consultation',
        },
        nameOf,
      ),
      'Scout ⇢ Maker',
    );
    assert.equal(
      sceneActorLabel({ kind: 'delegation', at: '', actorId: 'scout', toActorId: 'maker' }, nameOf),
      'Scout → Maker',
    );
  });

  it('summarizes complete and minimal tool-call scenes', () => {
    assert.equal(
      formatToolCallScene({
        kind: 'tool-call',
        at: '',
        name: 'write_file',
        count: 2,
        success: false,
        path: 'report.md',
        argsSummary: 'replace section',
        diffStats: { addedLines: 12, removedLines: 3 },
        durationMs: 49.6,
      }),
      'write_file ×2  ·  FAILED  ·  report.md  ·  replace section  ·  +12 −3  ·  50ms',
    );
    assert.equal(formatToolCallScene({ kind: 'tool-call', at: '' }), '?');
  });
});
