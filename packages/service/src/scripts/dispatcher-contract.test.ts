import { SCRIPT_METHOD_CAPABILITIES } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import { buildDispatcher } from './dispatcher.js';

/**
 * The dispatcher's handler table and the shared method-to-capability map
 * must agree: every handler is a method the SDK declares, and gates on the
 * capability the map says. The runner checks the map before dispatching;
 * a handler gating differently would be a second, silent policy.
 */
describe('dispatcher handlers against the shared capability map', () => {
  const { handlers } = buildDispatcher({ store: {} as Store });

  it('declares only methods the SDK contract knows', () => {
    const unknown = Object.keys(handlers).filter(
      (method) => !(method in SCRIPT_METHOD_CAPABILITIES),
    );
    expect(unknown).toEqual([]);
  });

  it('gates every method on the capability the shared map names', () => {
    const disagreements = Object.entries(handlers)
      .filter(([method, entry]) => entry.capability !== SCRIPT_METHOD_CAPABILITIES[method])
      .map(
        ([method, entry]) =>
          `${method}: handler=${entry.capability} map=${SCRIPT_METHOD_CAPABILITIES[method]}`,
      );
    expect(disagreements).toEqual([]);
  });

  it('leaves the nested run to the runner, which intercepts it before dispatch', () => {
    expect(handlers['script.run']).toBeUndefined();
    expect(SCRIPT_METHOD_CAPABILITIES['script.run']).toBeNull();
  });
});
