import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GezelSdkError } from './errors.js';
import { applyHostEnvironment, hostedGezelHome, resolveNodePath } from './host-home.js';

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
    expect(env.GEZEL_PORT).toBeUndefined();
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
      expect(() => resolveNodePath({}, {})).toThrow(/host\.nodePath/);
    } finally {
      delete versions.electron;
    }
  });
});
