import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveSpectralRuntime,
  runSpectralAction,
  runSpectralSelfTest,
  spectralReadRoots,
} from './spectral-host.js';

const require = createRequire(import.meta.url);
const built = existsSync(require.resolve('@bendyline/gezel-connectors-spectral/run-action'));

/**
 * The Spectral runner through the REAL sandbox, with the read roots and flags
 * a sync uses. Every other Spectral test mocks this spawn, which is how a
 * runner that could not read its own SDK shipped unnoticed.
 */
describe('the folders the Spectral runner is granted', () => {
  // Real paths, so native separators: containment is judged on `sep`.
  it('keeps the node_modules that holds both runner and SDK in a flat install', () => {
    const flat = join('/srv', 'app', 'node_modules');
    expect(
      spectralReadRoots(join(flat, '@bendyline', 'gezel-connectors-spectral'), [flat]),
    ).toEqual([flat]);
  });

  it('keeps the runner and the pnpm store apart when neither holds the other', () => {
    const runner = join('/repo', 'packages', 'connectors-spectral');
    const store = join('/repo', 'node_modules', '.pnpm');
    expect(spectralReadRoots(runner, [store]).sort()).toEqual([store, runner]);
  });
});

describe.runIf(built)('the Spectral runner under the sandbox', () => {
  it('grants the SDK folders, never a volume root or the home folder', () => {
    const { entry, readRoots } = resolveSpectralRuntime();
    expect(existsSync(entry)).toBe(true);
    expect(readRoots.length).toBeGreaterThanOrEqual(2);
    for (const root of readRoots) {
      expect(root).not.toBe(homedir());
      expect(homedir().startsWith(`${root}${sep}`)).toBe(false);
    }
  });

  it('loads the SDK and runs an action', async () => {
    const { data } = await runSpectralAction({
      component: 'echo',
      action: 'list',
      connectionInput: 'connection',
      connection: null,
      inputs: { records: [{ id: '1', title: 'hello' }] },
    });
    expect(data).toEqual([{ id: '1', title: 'hello' }]);
  });

  it('the self-test the installed-package smoke uses passes', async () => {
    expect(await runSpectralSelfTest()).toEqual({ ok: true });
  });
});
