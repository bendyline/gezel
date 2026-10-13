import { describe, expect, it } from 'vitest';
import { chatLaunchInvocationKey } from './chat-launch-key.js';

describe('chatLaunchInvocationKeyAsync (the phone)', () => {
  it('derives the same key as the desktop for the same launch', async () => {
    const { chatLaunchInvocationKeyAsync } = await import('@bendyline/gezel');
    const args = {
      sessionId: 'session-1',
      message: 'Tidy up this spreadsheet.',
      launch: {
        craftbookId: 'tidy-spreadsheet',
        params: {},
        inputs: { source: { from: 'sample' as const, sampleId: 'club-members' } },
      },
    };
    expect(await chatLaunchInvocationKeyAsync(args)).toBe(chatLaunchInvocationKey(args));
  });
});
