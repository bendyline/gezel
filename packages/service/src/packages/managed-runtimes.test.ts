import { delimiter, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverManagedScriptRuntimes, ensureBundledNodeOnPath } from './managed-runtimes.js';

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

describe('ensureBundledNodeOnPath', () => {
  it('prepends the bundled Node directory once', () => {
    const nodePath = join('managed', 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
    const nodeDir = dirname(nodePath);
    const env: NodeJS.ProcessEnv = {
      GEZEL_NODE_PATH: nodePath,
      PATH: join('system', 'bin'),
    };

    ensureBundledNodeOnPath({ env, exists: () => true });
    expect(env.PATH).toBe(`${nodeDir}${delimiter}${join('system', 'bin')}`);

    ensureBundledNodeOnPath({ env, exists: () => true });
    expect(env.PATH).toBe(`${nodeDir}${delimiter}${join('system', 'bin')}`);
  });

  it('leaves PATH alone when the configured Node does not exist', () => {
    const env: NodeJS.ProcessEnv = {
      GEZEL_NODE_PATH: join('missing', 'bin', 'node'),
      PATH: join('system', 'bin'),
    };
    ensureBundledNodeOnPath({ env, exists: () => false });
    expect(env.PATH).toBe(join('system', 'bin'));
  });
});
