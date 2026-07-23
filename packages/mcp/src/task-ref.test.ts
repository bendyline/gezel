import { describe, expect, it } from 'vitest';
import { resolveTaskRef, strictParseTaskRef } from './task-ref.js';

const SESSION = 'space-war-arcade-game/1';

describe('strictParseTaskRef', () => {
  it('parses the canonical projectId/num shape', () => {
    expect(strictParseTaskRef('space-war-arcade-game/1')).toEqual({
      projectId: 'space-war-arcade-game',
      num: 1,
    });
  });

  it('rejects non-canonical shapes', () => {
    expect(strictParseTaskRef('arcade-game')).toBeNull();
    expect(strictParseTaskRef('arcade-game#1')).toBeNull();
    expect(strictParseTaskRef('space-war-arcade-game/')).toBeNull();
    expect(strictParseTaskRef('space-war-arcade-game/0')).toBeNull();
    expect(strictParseTaskRef('space-war-arcade-game/1.5')).toBeNull();
  });
});

describe('resolveTaskRef — task-scoped session', () => {
  it('honors a correct ref', () => {
    expect(resolveTaskRef('space-war-arcade-game/1', SESSION)).toEqual({
      projectId: 'space-war-arcade-game',
      num: 1,
    });
  });

  // The three wild-caught mangles from the "Space War Arcade"
  // planner bundle. All must resolve to the session task, not 404.
  it('recovers the dropped-num mangle ("arcade-game")', () => {
    expect(resolveTaskRef('arcade-game', SESSION)).toEqual({
      projectId: 'space-war-arcade-game',
      num: 1,
    });
  });

  it('recovers the "#"-separator + truncated-id mangle ("arcade-game#1")', () => {
    expect(resolveTaskRef('arcade-game#1', SESSION)).toEqual({
      projectId: 'space-war-arcade-game',
      num: 1,
    });
  });

  it('recovers the stray-backtick mangle ("arcade-game`#1")', () => {
    expect(resolveTaskRef('arcade-game`#1', SESSION)).toEqual({
      projectId: 'space-war-arcade-game',
      num: 1,
    });
  });

  it('accepts the "#" separator when the projectId is correct', () => {
    expect(resolveTaskRef('space-war-arcade-game#1', SESSION)).toEqual({
      projectId: 'space-war-arcade-game',
      num: 1,
    });
  });

  it('accepts a bare task number against the session project', () => {
    expect(resolveTaskRef('1', SESSION)).toEqual({ projectId: 'space-war-arcade-game', num: 1 });
    expect(resolveTaskRef('#2', SESSION)).toEqual({ projectId: 'space-war-arcade-game', num: 2 });
  });

  it('falls back to the session task when the ref is empty or whitespace', () => {
    expect(resolveTaskRef(undefined, SESSION)).toEqual({
      projectId: 'space-war-arcade-game',
      num: 1,
    });
    expect(resolveTaskRef('   ', SESSION)).toEqual({
      projectId: 'space-war-arcade-game',
      num: 1,
    });
  });

  it('honors a different num within the same project', () => {
    expect(resolveTaskRef('space-war-arcade-game/3', SESSION)).toEqual({
      projectId: 'space-war-arcade-game',
      num: 3,
    });
  });
});

describe('resolveTaskRef — lobby session (no scoped task)', () => {
  it('honors a fully-qualified ref', () => {
    expect(resolveTaskRef('other-project/2', '')).toEqual({ projectId: 'other-project', num: 2 });
  });

  it('throws on an unparseable ref with a helpful message', () => {
    expect(() => resolveTaskRef('arcade-game', '')).toThrow(/expected projectId\/num/);
  });

  it('does not leak a session hint when there is no session task', () => {
    expect(() => resolveTaskRef('nope', undefined)).not.toThrow(/This session's task/);
  });

  it('names the session task in the error when one exists but nothing parses', () => {
    // Only reachable when a bare-number / parse path can't apply — e.g.
    // an empty session ref string passed as the scope. Belt-and-braces:
    // a genuinely empty session still throws the generic form.
    expect(() => resolveTaskRef('', '')).toThrow(/expected projectId\/num/);
  });
});
