import { describe, expect, it } from 'vitest';
import { piExtensionDir, piExtensionPath, resolvePiAgentDir } from './agent-dir.js';

describe('resolvePiAgentDir', () => {
  it('prefers an explicit override', () => {
    expect(
      resolvePiAgentDir({
        override: '/tmp/pi-agent',
        env: { PI_CODING_AGENT_DIR: '/elsewhere' },
        home: '/Users/mike',
      }),
    ).toEqual({ dir: '/tmp/pi-agent', source: 'override' });
  });

  it('honours PI_CODING_AGENT_DIR when the daemon can see it', () => {
    expect(
      resolvePiAgentDir({ env: { PI_CODING_AGENT_DIR: '/srv/pi' }, home: '/Users/mike' }),
    ).toEqual({ dir: '/srv/pi', source: 'env' });
  });

  it('falls back to the conventional root', () => {
    // A relative override is not something pi would accept either, so it must
    // not silently become a directory Gezel writes into.
    expect(
      resolvePiAgentDir({ env: { PI_CODING_AGENT_DIR: 'relative/pi' }, home: '/Users/mike' }),
    ).toEqual({ dir: '/Users/mike/.pi/agent', source: 'default' });
    expect(resolvePiAgentDir({ env: {}, home: '/Users/mike' })).toEqual({
      dir: '/Users/mike/.pi/agent',
      source: 'default',
    });
  });
});

describe('extension paths', () => {
  it('targets the directory pi auto-loads', () => {
    expect(piExtensionDir('/Users/mike/.pi/agent')).toBe('/Users/mike/.pi/agent/extensions');
    expect(piExtensionPath('/Users/mike/.pi/agent')).toBe(
      '/Users/mike/.pi/agent/extensions/gezel.js',
    );
  });
});
