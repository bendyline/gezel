import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openCodePluginDir, openCodePluginPath, resolveOpenCodeConfigDir } from './config-dir.js';

const HOME = '/Users/mike';
// Only the probe reports a path verbatim; every fallback joins with the host
// separator, so those read `\Users\mike\.config\opencode` on Windows. Spell the
// expectations the same way rather than pinning POSIX-only shapes.
const DEFAULT_CONFIG_DIR = join(HOME, '.config', 'opencode');

const PATHS_OUTPUT = `home       /Users/mike
data       /Users/mike/.local/share/opencode
bin        /Users/mike/.cache/opencode/bin
log        /Users/mike/.local/share/opencode/log
cache      /Users/mike/.cache/opencode
config     /Users/mike/.config/opencode
state      /Users/mike/.local/state/opencode
`;

describe('resolveOpenCodeConfigDir', () => {
  it('asks OpenCode where its config lives', async () => {
    const calls: Array<{ path: string; args: string[] }> = [];

    const resolved = await resolveOpenCodeConfigDir({
      binaryPath: '/usr/local/bin/opencode',
      env: {},
      home: HOME,
      probe: async (path, args) => {
        calls.push({ path, args });
        return PATHS_OUTPUT;
      },
    });

    // A probed path is taken verbatim from OpenCode's own output, separators
    // and all — no join, so no platform variance.
    expect(resolved).toEqual({ dir: '/Users/mike/.config/opencode', source: 'probe' });
    expect(calls).toEqual([{ path: '/usr/local/bin/opencode', args: ['debug', 'paths'] }]);
  });

  it('falls back to XDG when the probe fails', async () => {
    const resolved = await resolveOpenCodeConfigDir({
      binaryPath: '/usr/local/bin/opencode',
      env: { XDG_CONFIG_HOME: '/Users/mike/xdg' },
      home: HOME,
      probe: async () => {
        throw new Error('opencode is too old for `debug paths`');
      },
    });

    expect(resolved).toEqual({ dir: join('/Users/mike/xdg', 'opencode'), source: 'xdg' });
  });

  it.each([
    ['prints no config line', 'home  /Users/mike\n'],
    ['prints a relative path', 'config  ../opencode\n'],
    ['prints nothing at all', ''],
  ])('falls back to the conventional location when the probe %s', async (_label, output) => {
    const resolved = await resolveOpenCodeConfigDir({
      binaryPath: '/usr/local/bin/opencode',
      env: {},
      home: HOME,
      probe: async () => output,
    });

    expect(resolved).toEqual({ dir: DEFAULT_CONFIG_DIR, source: 'default' });
  });

  it('ignores a relative XDG_CONFIG_HOME', async () => {
    const resolved = await resolveOpenCodeConfigDir({
      env: { XDG_CONFIG_HOME: 'relative/config' },
      home: HOME,
    });

    expect(resolved).toEqual({ dir: DEFAULT_CONFIG_DIR, source: 'default' });
  });

  it('does not probe when OpenCode was not found', async () => {
    let probed = false;

    const resolved = await resolveOpenCodeConfigDir({
      env: {},
      home: HOME,
      probe: async () => {
        probed = true;
        return PATHS_OUTPUT;
      },
    });

    expect(probed).toBe(false);
    expect(resolved.source).toBe('default');
  });
});

describe('plugin paths', () => {
  it('targets the documented plugins directory', () => {
    expect(openCodePluginDir(DEFAULT_CONFIG_DIR)).toBe(join(DEFAULT_CONFIG_DIR, 'plugins'));
    expect(openCodePluginPath(DEFAULT_CONFIG_DIR)).toBe(
      join(DEFAULT_CONFIG_DIR, 'plugins', 'gezel.js'),
    );
  });
});
