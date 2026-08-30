import { afterEach, describe, expect, it } from 'vitest';
import {
  MEESTER_THREAD_KEY,
  clearChatThreadSelection,
  gezelAllProjectsThreadKey,
  gezelThreadKey,
  projectRecipientKey,
  projectThreadKey,
  readChatThreadSelection,
  resetChatThreadMemory,
  writeChatThreadSelection,
} from './chat-thread-memory.js';

afterEach(() => resetChatThreadMemory());

describe('thread keys', () => {
  it('scope a gezel tab per project and keep the all-projects mode separate', () => {
    expect(gezelThreadKey('tomas', 'gezel')).not.toBe(gezelThreadKey('tomas', 'squisq'));
    expect(gezelAllProjectsThreadKey('tomas')).not.toBe(gezelThreadKey('tomas', 'gezel'));
  });

  it('separate a project chat recipient from that recipient thread', () => {
    expect(projectRecipientKey('gezel')).not.toBe(projectThreadKey('gezel', 'tomas'));
  });
});

describe('selection storage', () => {
  it('round-trips a selection', () => {
    writeChatThreadSelection(MEESTER_THREAD_KEY, {
      gezelId: 'tomas',
      projectId: 'gezel',
      sessionId: 'session-1',
    });
    expect(readChatThreadSelection(MEESTER_THREAD_KEY)).toEqual({
      gezelId: 'tomas',
      projectId: 'gezel',
      sessionId: 'session-1',
    });
  });

  it('merges patches instead of blanking fields the patch is silent about', () => {
    writeChatThreadSelection('k', { gezelId: 'tomas', projectId: 'gezel' });
    writeChatThreadSelection('k', { sessionId: 'session-2' });
    expect(readChatThreadSelection('k')).toEqual({
      gezelId: 'tomas',
      projectId: 'gezel',
      sessionId: 'session-2',
    });
  });

  it('forgets a field when handed an explicit empty string', () => {
    writeChatThreadSelection('k', { sessionId: 'session-1' });
    writeChatThreadSelection('k', { sessionId: '' });
    expect(readChatThreadSelection('k')?.sessionId).toBe('');
  });

  it('reports undefined for a key nobody wrote, and after a clear', () => {
    expect(readChatThreadSelection('missing')).toBeUndefined();
    writeChatThreadSelection('k', { sessionId: 'session-1' });
    clearChatThreadSelection('k');
    expect(readChatThreadSelection('k')).toBeUndefined();
  });
});
