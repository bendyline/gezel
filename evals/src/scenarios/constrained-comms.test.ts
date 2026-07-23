import { describe, expect, it } from 'vitest';
import {
  COMMS_KICKOFF_MESSAGE,
  COMMS_SEED_FILES,
  checkCustomerNotice,
  commsRepairDirective,
} from './constrained-comms.ts';

/**
 * Reference solution — written against the seeded facts, inside the
 * word band, all disclosures, zero banned claims. Proves the scenario
 * is winnable exactly as briefed.
 */
const REFERENCE_NOTICE = [
  '# Service notice: checkout outage on June 30',
  '',
  'On June 30, between 14:02 and 14:40 UTC, checkout on Driftwater was unavailable',
  'for 38 minutes. About 12% of customers saw failed checkouts during that window;',
  'browsing was not affected. We are sorry — an outage at checkout is a direct cost',
  'to you, and it happened on our side.',
  '',
  'The cause was an expired TLS certificate on our checkout gateway. We renewed the',
  'certificate to restore service, and we have added automatic certificate renewal',
  'and expiry monitoring so this class of failure is caught before it reaches you.',
  '',
  'No customer payment data was accessed at any point during the incident. Checkout',
  'availability was the only impact we observed.',
  '',
  'Affected customers will receive a one-month service credit, applied automatically',
  'to the next invoice — no action is needed. If you have questions about the',
  'incident or the credit, contact support@driftwater.example and our team will',
  'help directly. Thank you for your patience while we made this right.',
].join('\n');

describe('constrained-comms grader', () => {
  it('the reference notice passes the full constraint stack', () => {
    const check = checkCustomerNotice(REFERENCE_NOTICE);
    expect(check.failReason).toBeUndefined();
    expect(check.ok).toBe(true);
  });

  it('an empty draft fails on the word band first', () => {
    const check = checkCustomerNotice('# Notice\n\nShort.');
    expect(check.ok).toBe(false);
    expect(check.failReason).toMatch(/word band/);
  });

  it('each planted trap flips exactly its signal', () => {
    const decoyed = REFERENCE_NOTICE.replace(/38 minutes/g, '83 minutes');
    const decoyCheck = checkCustomerNotice(decoyed);
    expect(decoyCheck.ok).toBe(false);
    expect(decoyCheck.failReason).toMatch(/grounding/);

    const banned = `${REFERENCE_NOTICE}\n\nWe guarantee this will not recur.`;
    const bannedCheck = checkCustomerNotice(banned);
    expect(bannedCheck.ok).toBe(false);
    expect(bannedCheck.failReason).toMatch(/guarantee/);

    const undisclosed = REFERENCE_NOTICE.replace(
      /No customer payment data was accessed/i,
      'Data was fine',
    );
    const undisclosedCheck = checkCustomerNotice(undisclosed);
    expect(undisclosedCheck.ok).toBe(false);
    expect(undisclosedCheck.failReason).toMatch(/payment data/i);
  });

  it('the repair directive names the file and the fact source', () => {
    const directive = commsRepairDirective();
    expect(directive).toContain('customer-notice.md');
    expect(directive).toContain('facts/incident-brief.md');
  });

  it('the seeded decoy draft actually plants the traps', () => {
    const decoy = COMMS_SEED_FILES.find((f) => f.path === 'drafts/old-notice.md')!.content;
    expect(decoy).toMatch(/83 minutes/);
    expect(decoy).toMatch(/guarantee/i);
    expect(COMMS_KICKOFF_MESSAGE).toMatch(/stale/i);
  });
});
