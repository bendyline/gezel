import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { piExtensionDir, piExtensionPath, resolvePiAgentDir } from './agent-dir.js';

const HOME = '/Users/mike';
// The resolver joins with the host separator, so the conventional root reads
// `\Users\mike\.pi\agent` on Windows. Spell the expectation the same way rather
// than pinning POSIX shapes that only pass on the developer's own platform.
const DEFAULT_AGENT_DIR = join(HOME, '.pi', 'agent');

describe('resolvePiAgentDir', () => {
  it('prefers an explicit override', () => {
    expect(
      resolvePiAgentDir({
        override: '/tmp/pi-agent',
        env: { PI_CODING_AGENT_DIR: '/elsewhere' },
        home: HOME,
      }),
    ).toEqual({ dir: '/tmp/pi-agent', source: 'override' });
  });

  it('honours PI_CODING_AGENT_DIR when the daemon can see it', () => {
    expect(resolvePiAgentDir({ env: { PI_CODING_AGENT_DIR: '/srv/pi' }, home: HOME })).toEqual({
      dir: '/srv/pi',
      source: 'env',
    });
  });

  it('falls back to the conventional root', () => {
    // A relative override is not something pi would accept either, so it must
    // not silently become a directory Gezel writes into.
    expect(resolvePiAgentDir({ env: { PI_CODING_AGENT_DIR: 'relative/pi' }, home: HOME })).toEqual({
      dir: DEFAULT_AGENT_DIR,
      source: 'default',
    });
    expect(resolvePiAgentDir({ env: {}, home: HOME })).toEqual({
      dir: DEFAULT_AGENT_DIR,
      source: 'default',
    });
  });
});

describe('extension paths', () => {
  it('targets the directory pi auto-loads', () => {
    expect(piExtensionDir(DEFAULT_AGENT_DIR)).toBe(join(DEFAULT_AGENT_DIR, 'extensions'));
    expect(piExtensionPath(DEFAULT_AGENT_DIR)).toBe(
      join(DEFAULT_AGENT_DIR, 'extensions', 'gezel.js'),
    );
  });
});
