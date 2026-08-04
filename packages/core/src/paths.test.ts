import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  gezelDir,
  gezelHome,
  gezelPaths,
  machineSharedHome,
  machineSharedMarkerFile,
  projectDir,
  projectScriptFile,
  projectScriptRunFile,
  projectScriptRunsDir,
  projectScriptsDir,
  projectTaskDir,
  projectTaskFile,
  projectTaskNextIdFile,
  projectTaskNotesFile,
  projectTasksDir,
} from './paths.js';

describe('gezelHome', () => {
  it('defaults to ~/.gezel', () => {
    const home = gezelHome({});
    expect(home).toBe(join(homedir(), '.gezel'));
  });

  it('respects GEZEL_HOME override', () => {
    const home = gezelHome({ GEZEL_HOME: '/tmp/lv-test' });
    expect(home).toBe('/tmp/lv-test');
  });
});

describe('machineSharedHome', () => {
  it('keeps shared product data separate from the broker home on every platform', () => {
    expect(machineSharedHome('win32', { ProgramData: 'D:\\MachineData' })).toBe(
      'D:\\MachineData\\Gezel\\shared',
    );
    expect(machineSharedHome('darwin', {})).toBe('/Users/Shared/Gezel');
    expect(machineSharedHome('linux', {})).toBe('/var/lib/gezel/shared');
  });

  it('honors the explicit operator/test override', () => {
    expect(machineSharedHome('darwin', { GEZEL_MACHINE_SHARED_HOME: '/tmp/shared-gezel' })).toBe(
      '/tmp/shared-gezel',
    );
    expect(
      machineSharedMarkerFile('darwin', { GEZEL_MACHINE_SHARED_HOME: '/tmp/shared-gezel' }),
    ).toBe('/tmp/shared-gezel/.gezel-machine-shared-v1.json');
  });
});

// Compose expected paths via `join` so the assertions match whichever
// separator the host filesystem uses ('/' on POSIX, '\\' on Windows). The
// production helpers go through `path.join`, so hand-rolling the slash
// style in the test would lock us to one platform — exactly the kind of
// thing this codebase is supposed to be portable across.
const ROOT = '/tmp/lv';

describe('gezelPaths', () => {
  it('builds the full directory structure from a root', () => {
    const p = gezelPaths(ROOT);
    expect(p.root).toBe(ROOT);
    expect(p.config).toBe(join(ROOT, 'config.json'));
    expect(p.gezels).toBe(join(ROOT, 'gezels'));
    expect(p.projects).toBe(join(ROOT, 'projects'));
    expect(p.runtime.pid).toBe(join(ROOT, 'runtime', 'pid'));
    expect(p.runtime.port).toBe(join(ROOT, 'runtime', 'port'));
    expect(p.runtime.token).toBe(join(ROOT, 'runtime', 'auth-token'));
    expect(p.runtime.cert).toBe(join(ROOT, 'runtime', 'cert.pem'));
    expect(p.runtime.fingerprint).toBe(join(ROOT, 'runtime', 'cert-fingerprint'));
    expect(p.logs).toBe(join(ROOT, 'logs'));
  });
});

describe('gezelDir', () => {
  it('returns gezels/<id> under the root', () => {
    expect(gezelDir(ROOT, 'researcher')).toBe(join(ROOT, 'gezels', 'researcher'));
  });
});

describe('projectDir', () => {
  it('returns projects/<id> under the root', () => {
    expect(projectDir(ROOT, 'default')).toBe(join(ROOT, 'projects', 'default'));
  });
});

describe('project task paths', () => {
  it('compose under projects/<id>/tasks', () => {
    expect(projectTasksDir(ROOT, 'default')).toBe(join(ROOT, 'projects', 'default', 'tasks'));
    expect(projectTaskNextIdFile(ROOT, 'default')).toBe(
      join(ROOT, 'projects', 'default', 'tasks', '.next-id'),
    );
    expect(projectTaskDir(ROOT, 'default', 7)).toBe(
      join(ROOT, 'projects', 'default', 'tasks', '7'),
    );
    expect(projectTaskFile(ROOT, 'default', 7)).toBe(
      join(ROOT, 'projects', 'default', 'tasks', '7', 'task.json'),
    );
    expect(projectTaskNotesFile(ROOT, 'default', 7)).toBe(
      join(ROOT, 'projects', 'default', 'tasks', '7', 'notes.jsonl'),
    );
  });
});

describe('project script paths', () => {
  it('compose under projects/<id>/scripts', () => {
    expect(projectScriptsDir(ROOT, 'default')).toBe(join(ROOT, 'projects', 'default', 'scripts'));
    expect(projectScriptFile(ROOT, 'default', 'fetch-rates')).toBe(
      join(ROOT, 'projects', 'default', 'scripts', 'fetch-rates.ts'),
    );
    expect(projectScriptRunsDir(ROOT, 'default')).toBe(
      join(ROOT, 'projects', 'default', 'scripts', 'runs'),
    );
    expect(projectScriptRunFile(ROOT, 'default', '2026-04-21', 'r1')).toBe(
      join(ROOT, 'projects', 'default', 'scripts', 'runs', '2026-04-21', 'r1.json'),
    );
  });
});
