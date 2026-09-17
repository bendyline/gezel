import { describe, expect, it } from 'vitest';
import * as advanced from './advanced.js';
import * as browser from './browser.js';
import * as host from './host.js';
import * as root from './index.js';

/**
 * The public surface, pinned.
 *
 * Consumers pin this SDK by exact version, so an export that appears or
 * disappears without anyone noticing is a contract change nobody reviewed.
 * Updating these lists is the deliberate act; the diff is the review.
 *
 * Type-only exports do not appear here — they carry no runtime value — so the
 * lists are shorter than the entry points read.
 */
describe('published surface', () => {
  it('root entry', () => {
    expect(Object.keys(root).sort()).toEqual([
      'GezelApp',
      'GezelSdkError',
      'authorize',
      'authorizeLocal',
      'authorizeLocalOwner',
      'connect',
      'connectLocal',
      'createPatientFetch',
      'createTrustingFetch',
      'detectGezel',
      'registerAppTools',
      'scopeNeedsVerificationCode',
    ]);
  });

  it('browser entry stays free of anything that needs Node', () => {
    // A browser app supplies its own baseUrl and token: discovery, consent and
    // hosting all need the filesystem and are deliberately absent here.
    expect(Object.keys(browser).sort()).toEqual(['GezelApp', 'GezelSdkError']);
  });

  it('host entry', () => {
    expect(Object.keys(host).sort()).toEqual([
      'Gezel',
      'GezelApp',
      'GezelChat',
      'GezelProject',
      'GezelSdkError',
      'connectOrHost',
      'hostedGezelHome',
      'registerAppTools',
    ]);
  });

  it('advanced entry carries only the escape hatch', () => {
    expect(Object.keys(advanced).sort()).toEqual(['unsafeProductClient']);
  });
});
