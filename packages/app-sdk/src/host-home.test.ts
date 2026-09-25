import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GezelSdkError } from './errors.js';
import {
  applyHostEnvironment,
  childHostEnvironment,
  computeHostEnvironment,
  hostedGezelHome,
  resolveNodePath,
} from './host-home.js';

describe('hostedGezelHome', () => {
  it("puts an app beside the user's Gezel, never inside it", () => {
    expect(hostedGezelHome('qualla', {})).toBe(join(homedir(), '.gezel', 'apps', 'qualla'));
    expect(hostedGezelHome('qualla', { GEZEL_HOME: '/tmp/scratch' })).toBe(
      join('/tmp/scratch', 'apps', 'qualla'),
    );
  });

  it('refuses an app id that would escape its own directory', () => {
    for (const bad of ['../evil', 'Qualla', 'has space', '', 'a/b']) {
      expect(() => hostedGezelHome(bad, {})).toThrow(GezelSdkError);
    }
  });
});

describe('applyHostEnvironment', () => {
  it('sets what a hosted daemon needs and puts it all back afterwards', () => {
    const env: NodeJS.ProcessEnv = {
      GEZEL_HOME: '/tmp/user-gezel',
      GEZEL_PORT: '6228',
      GEZEL_SERVICE_ROLE: 'machine-engine',
      GEZEL_SYSTEM_SCOPE: '1',
      PATH: '/usr/bin',
    };
    const applied = applyHostEnvironment(
      'qualla',
      { nodePath: '/opt/qualla/bin/node', nativeBinDir: '/opt/qualla/engines' },
      env,
    );

    expect(applied.home).toBe(join('/tmp/user-gezel', 'apps', 'qualla'));
    expect(env.GEZEL_HOME).toBe(applied.home);
    expect(env.GEZEL_SERVICE_ROLE).toBe('user');
    // An inherited port or system scope belongs to something else entirely.
    // The port is pinned ephemeral rather than cleared: cleared, gezeld would
    // claim the canonical 6228 that the machine broker or the user's own
    // Gezel expects to own.
    expect(env.GEZEL_PORT).toBe('0');
    expect(env.GEZEL_SYSTEM_SCOPE).toBeUndefined();
    // No Chromium download for an app that just wants a chat bot.
    expect(env.GEZEL_SKIP_SYSTEM_BOOTSTRAP).toBe('1');
    expect(env.GEZEL_NODE_PATH).toBe('/opt/qualla/bin/node');
    expect(env.PATH).toBe(`/opt/qualla/bin${delimiter}/usr/bin`);
    expect(env.GEZEL_NATIVE_BIN_DIR).toBe('/opt/qualla/engines');
    // The user's own models are readable; the app's own home is not listed
    // as something to borrow from itself.
    expect(env.GEZEL_READONLY_MODEL_HOMES).toBe('/tmp/user-gezel');

    applied.restore();
    expect(env).toEqual({
      GEZEL_HOME: '/tmp/user-gezel',
      GEZEL_PORT: '6228',
      GEZEL_SERVICE_ROLE: 'machine-engine',
      GEZEL_SYSTEM_SCOPE: '1',
      PATH: '/usr/bin',
    });
  });

  it('keeps the system bootstrap when the app asks for it', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    applyHostEnvironment('qualla', { nodePath: '/usr/bin/node', systemBootstrap: true }, env);
    expect(env.GEZEL_SKIP_SYSTEM_BOOTSTRAP).toBeUndefined();
  });

  it('drops a relative borrowed home instead of guessing what it meant', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    applyHostEnvironment(
      'qualla',
      { nodePath: '/usr/bin/node', readOnlyModelHomes: ['../elsewhere', '/srv/models'] },
      env,
    );
    expect(env.GEZEL_READONLY_MODEL_HOMES).toBe('/srv/models');
  });
});

describe('resolveNodePath', () => {
  it('uses this process when it is node', () => {
    expect(resolveNodePath({}, {})).toBe(process.execPath);
  });

  it('prefers an explicit path and then the environment', () => {
    expect(resolveNodePath({ nodePath: '/a/node' }, { GEZEL_NODE_PATH: '/b/node' })).toBe(
      '/a/node',
    );
    expect(resolveNodePath({}, { GEZEL_NODE_PATH: '/b/node' })).toBe('/b/node');
  });

  it('tells an Electron host exactly what it has to supply', () => {
    const versions = process.versions as { electron?: string };
    versions.electron = '32.0.0';
    try {
      expect(() => resolveNodePath({}, { GEZEL_HOME: '/no/gezel' }, () => false)).toThrow(
        /host\.nodePath/,
      );
    } finally {
      delete versions.electron;
    }
  });

  it('uses the Node a Gezel install keeps when an Electron host ships none', () => {
    const versions = process.versions as { electron?: string };
    versions.electron = '32.0.0';
    const managed = join(
      '/tmp/user-gezel',
      'bin',
      process.platform === 'win32' ? 'node.exe' : 'node',
    );
    try {
      expect(
        resolveNodePath({}, { GEZEL_HOME: '/tmp/user-gezel' }, (path) => path === managed),
      ).toBe(managed);
      // An app that ships its own Node never borrows Gezel's.
      expect(
        resolveNodePath(
          { nodePath: '/opt/app/node' },
          { GEZEL_HOME: '/tmp/user-gezel' },
          () => true,
        ),
      ).toBe('/opt/app/node');
    } finally {
      delete versions.electron;
    }
  });
});

describe('computeHostEnvironment', () => {
  const base = { nodePath: '/opt/qualla/bin/node' };

  it('carries the distribution profile down to the daemon', () => {
    // A store build must refuse runtime code downloads, and the daemon reads
    // that from the environment. Before this, a store-packaged consumer had to
    // set the variable by hand before importing the SDK.
    const { variables } = computeHostEnvironment(
      'qualla',
      { ...base, distributionProfile: 'store' },
      { PATH: '/usr/bin' },
    );
    expect(variables.get('GEZEL_DISTRIBUTION_PROFILE')).toBe('store');
  });

  it('leaves the profile alone when the app does not declare one', () => {
    const { variables } = computeHostEnvironment('qualla', base, { PATH: '/usr/bin' });
    expect(variables.has('GEZEL_DISTRIBUTION_PROFILE')).toBe(false);
  });

  it('replaces an inherited port with an ephemeral one and removes a system scope', () => {
    const { variables } = computeHostEnvironment('qualla', base, {
      PATH: '/usr/bin',
      GEZEL_PORT: '6228',
      GEZEL_SYSTEM_SCOPE: '1',
    });
    expect(variables.get('GEZEL_PORT')).toBe('0');
    expect(variables.has('GEZEL_SYSTEM_SCOPE')).toBe(true);
    expect(variables.get('GEZEL_SYSTEM_SCOPE')).toBeUndefined();
  });

  it('never lets a private daemon take the canonical port, inherited or not', () => {
    // With nothing inherited, gezeld's own default is 6228 — the address the
    // machine broker or the user's Gezel expects to own.
    const { variables } = computeHostEnvironment('qualla', base, { PATH: '/usr/bin' });
    expect(variables.get('GEZEL_PORT')).toBe('0');
  });
});

describe('childHostEnvironment', () => {
  const base = { nodePath: '/opt/qualla/bin/node' };

  it('builds the child environment without touching the parent', () => {
    // A spawned daemon gets its own environment. Mutating this process's would
    // be wrong for the parent and pointless for the child.
    const parent: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      GEZEL_HOME: '/tmp/user-gezel',
      GEZEL_PORT: '6228',
    };
    const snapshot = { ...parent };
    const { home, env } = childHostEnvironment('qualla', base, parent);

    expect(parent).toEqual(snapshot);
    expect(env.GEZEL_HOME).toBe(home);
    expect(env.GEZEL_SERVICE_ROLE).toBe('user');
  });

  it('unsets rather than blanks a variable the daemon must not inherit', () => {
    const { env } = childHostEnvironment('qualla', base, {
      PATH: '/usr/bin',
      GEZEL_SYSTEM_SCOPE: '1',
    });
    // An empty string is a value; the daemon would read it and try to use it.
    expect('GEZEL_SYSTEM_SCOPE' in env).toBe(false);
  });

  it('hands the spawned daemon an ephemeral port', () => {
    const { env } = childHostEnvironment('qualla', base, { PATH: '/usr/bin', GEZEL_PORT: '6228' });
    expect(env.GEZEL_PORT).toBe('0');
  });

  it('agrees with the applied environment on every variable', () => {
    const parent: NodeJS.ProcessEnv = { PATH: '/usr/bin', GEZEL_HOME: '/tmp/user-gezel' };
    const child = childHostEnvironment('qualla', base, { ...parent });

    const applyTarget: NodeJS.ProcessEnv = { ...parent };
    applyHostEnvironment('qualla', base, applyTarget);

    for (const key of ['GEZEL_HOME', 'GEZEL_SERVICE_ROLE', 'GEZEL_NODE_PATH', 'PATH']) {
      expect(child.env[key], key).toBe(applyTarget[key]);
    }
  });
});
