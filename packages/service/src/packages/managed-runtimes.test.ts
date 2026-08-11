import { describe, expect, it } from 'vitest';
import { discoverManagedScriptRuntimes } from './managed-runtimes.js';

describe('discoverManagedScriptRuntimes', () => {
  it('restores both managed paths when Task Scheduler launched the bundled Node', () => {
    const env: NodeJS.ProcessEnv = {};
    discoverManagedScriptRuntimes('C:\\Users\\Tester\\.gezel', {
      platform: 'win32',
      execPath: 'C:\\Users\\Tester\\.gezel\\bin\\node.exe',
      env,
      exists: () => true,
    });
    expect(env.GEZEL_NODE_PATH).toBe('C:\\Users\\Tester\\.gezel\\bin\\node.exe');
    expect(env.GEZEL_PNPM_PATH).toBe('C:\\Users\\Tester\\.gezel\\bin\\pnpm-runtime\\bin\\pnpm.mjs');
  });

  it('does not trust a different Node executable or overwrite explicit runtime paths', () => {
    const env: NodeJS.ProcessEnv = {
      GEZEL_NODE_PATH: '/explicit/node',
      GEZEL_PNPM_PATH: '/explicit/pnpm',
    };
    discoverManagedScriptRuntimes('/home/tester/.gezel', {
      platform: 'linux',
      execPath: '/usr/bin/node',
      env,
      exists: () => true,
    });
    expect(env.GEZEL_NODE_PATH).toBe('/explicit/node');
    expect(env.GEZEL_PNPM_PATH).toBe('/explicit/pnpm');
  });
});
