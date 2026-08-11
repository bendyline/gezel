import { describe, expect, it } from 'vitest';
import { rendererConnectionSnapshot } from './renderer-connection.js';

const ready = {
  state: 'ready' as const,
  token: 'rotated-token',
  baseUrl: 'https://127.0.0.1:6228',
  fallbackReason: { code: 'restart-failed', message: 'using embedded recovery' },
  mode: 'embedded',
};

describe('rendererConnectionSnapshot', () => {
  it('publishes only a ready connection generation', () => {
    expect(rendererConnectionSnapshot(ready)).toEqual({
      token: 'rotated-token',
      baseUrl: 'https://127.0.0.1:6228',
      fallbackReason: 'using embedded recovery',
      fallbackCode: 'restart-failed',
      mode: 'embedded',
    });
  });

  it.each(['restarting', 'failed'] as const)(
    'withholds stale credentials while the supervisor is %s',
    (state) => {
      expect(rendererConnectionSnapshot({ ...ready, state })).toBeNull();
    },
  );

  it('withholds an empty token and a missing connection', () => {
    expect(rendererConnectionSnapshot({ ...ready, token: '' })).toBeNull();
    expect(rendererConnectionSnapshot(null)).toBeNull();
  });
});
