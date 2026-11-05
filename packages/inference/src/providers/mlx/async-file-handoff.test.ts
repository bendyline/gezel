import { asyncHandoffReleaseInstruction, messageGezelText } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { asyncHandoffClosing, asyncHandoffRecipient } from './async-file-handoff.js';

// The delegate_* tools word their result in packages/mcp/src/server.ts.
function delegateResult(
  name: string,
  deliveryState: 'parked' | 'dispatched',
  deduplicated = false,
): string {
  const release = asyncHandoffReleaseInstruction(name, deliveryState);
  return deduplicated
    ? `An identical file handoff is already pending with ${name} (Illustrator); joined it instead of creating another message. ${release}`
    : `${deliveryState === 'parked' ? 'Accepted the handoff for' : 'Dispatched the handoff to'} ${name} (Illustrator) in project "Default". ${release} [hint: ${name} is now on that project; the user can switch to their chat for follow-ups.]`;
}

describe('the recipient a handoff result names', () => {
  it('reads every wording the message and delegate tools produce', () => {
    for (const deliveryState of ['parked', 'dispatched'] as const) {
      expect(asyncHandoffRecipient(messageGezelText({ recipientName: 'Pim', deliveryState }))).toBe(
        'Pim',
      );
      expect(
        asyncHandoffRecipient(
          messageGezelText({
            recipientName: 'Pim',
            deliveryState,
            expectedFilePath: 'out/lighthouse.png',
          }),
        ),
      ).toBe('Pim');
      expect(
        asyncHandoffRecipient(
          messageGezelText({ recipientName: 'Pim', deliveryState, deduplicated: true }),
        ),
      ).toBe('Pim');
      expect(asyncHandoffRecipient(delegateResult('Pim', deliveryState))).toBe('Pim');
      expect(asyncHandoffRecipient(delegateResult('Pim', deliveryState, true))).toBe('Pim');
    }
  });

  it('keeps a whole name that holds spaces or a period', () => {
    expect(
      asyncHandoffRecipient(
        messageGezelText({ recipientName: 'Mary Ann', deliveryState: 'parked' }),
      ),
    ).toBe('Mary Ann');
    expect(
      asyncHandoffRecipient(
        messageGezelText({ recipientName: 'Dr. Vos', deliveryState: 'parked' }),
      ),
    ).toBe('Dr. Vos');
    expect(asyncHandoffRecipient(delegateResult('Dr. Vos', 'dispatched'))).toBe('Dr. Vos');
  });

  it('names nobody when the result is worded some other way', () => {
    expect(asyncHandoffRecipient('Hieu is on it.')).toBeUndefined();
    expect(asyncHandoffRecipient('Accepted the message for Pim.')).toBeUndefined();
  });
});

describe('the reply after a delegating turn', () => {
  it('names who is on it in plain words', () => {
    expect(asyncHandoffClosing(['Pim'])).toBe('Pim is on it. Their reply will appear here.');
    expect(asyncHandoffClosing(['Pim', 'Pim'])).toBe('Pim is on it. Their reply will appear here.');
    expect(asyncHandoffClosing(['Pim', 'Koray'])).toBe(
      'Pim and Koray are on it. Their replies will appear here.',
    );
    expect(asyncHandoffClosing(['Pim', 'Koray', 'Liesel'])).toBe(
      'Pim, Koray, and Liesel are on it. Their replies will appear here.',
    );
  });

  it('says the work was passed on when a recipient is unknown', () => {
    expect(asyncHandoffClosing([undefined])).toBe(
      "I've passed this on. The reply will appear here.",
    );
    expect(asyncHandoffClosing(['Pim', undefined])).toBe(
      "I've passed this on. The replies will appear here.",
    );
  });

  it('never shows the person the runtime machinery', () => {
    for (const closing of [
      asyncHandoffClosing(['Pim']),
      asyncHandoffClosing(['Pim', 'Koray']),
      asyncHandoffClosing([undefined, undefined]),
    ]) {
      expect(closing).not.toMatch(/provider|queue|asynchronous|handoff|ended my turn/i);
    }
  });
});
