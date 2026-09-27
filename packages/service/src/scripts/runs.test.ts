import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { INTERRUPTED_SCRIPT_RUN_ERROR, type ScriptRun } from '@bendyline/gezel';
import { projectScriptRunFile, projectScriptRunsDir } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readProjectScriptRun,
  recoverInterruptedScriptRuns,
  writeProjectScriptRun,
} from './runs.js';

const reads = vi.hoisted(() => [] as string[]);
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: ((path: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
      reads.push(String(path));
      return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
    }) as typeof actual.readFile,
  };
});

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-script-runs-'));
  reads.length = 0;
});
afterEach(() => rm(home, { recursive: true, force: true }));

function record(id: string, startedAt: string, status: ScriptRun['status']): ScriptRun {
  return {
    id,
    projectId: 'default',
    scriptName: 'example',
    startedAt,
    ...(status === 'running' ? {} : { finishedAt: startedAt }),
    status,
    trigger: { kind: 'manual', userInitiated: true },
    inputs: {},
    calls: [],
    logs: '',
  };
}

async function writeHistory(count: number): Promise<string[]> {
  const files: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const date = `2025-0${1 + (index % 9)}-1${index % 10}`;
    const file = projectScriptRunFile(home, 'default', date, `old-${index}`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(record(`old-${index}`, `${date}T00:00:00.000Z`, 'ok')));
    files.push(file);
  }
  return files;
}

const inFlightDir = () => join(projectScriptRunsDir(home, 'default'), '.in-flight');

describe('script run recovery at boot', () => {
  it('settles a run left running, reading only its marker and record', async () => {
    const history = await writeHistory(40);
    const live = record('live-run', '2026-09-27T10:00:00.000Z', 'running');
    await writeProjectScriptRun(home, live);
    reads.length = 0;

    expect(await recoverInterruptedScriptRuns(home, ['default', 'no-runs'], () => 'later')).toBe(1);
    const readDuringRecovery = reads.splice(0);

    expect(readDuringRecovery.filter((path) => history.includes(path))).toEqual([]);
    // The marker, then the one record it names.
    expect(readDuringRecovery).toHaveLength(2);
    expect(await readProjectScriptRun(home, 'default', 'live-run')).toMatchObject({
      status: 'error',
      finishedAt: 'later',
      error: INTERRUPTED_SCRIPT_RUN_ERROR,
    });
    expect(await readdir(inFlightDir())).toEqual([]);
  });

  it('leaves no marker behind a finished run, so the next boot reads nothing', async () => {
    const run = record('done-run', '2026-09-27T10:00:00.000Z', 'running');
    await writeProjectScriptRun(home, run);
    await writeProjectScriptRun(home, { ...run, status: 'ok', finishedAt: run.startedAt });
    reads.length = 0;

    expect(await recoverInterruptedScriptRuns(home, ['default'])).toBe(0);
    expect(reads).toEqual([]);
    expect(await readProjectScriptRun(home, 'default', 'done-run')).toMatchObject({ status: 'ok' });
  });

  it('finds a record whose marker lost its date, and drops a marker without a record', async () => {
    const run = record('blank-marker', '2026-09-26T23:59:00.000Z', 'running');
    await writeProjectScriptRun(home, run);
    await writeFile(join(inFlightDir(), 'blank-marker'), '');
    await writeFile(join(inFlightDir(), 'never-written'), '2026-09-27');

    expect(await recoverInterruptedScriptRuns(home, ['default'])).toBe(1);
    expect(await readProjectScriptRun(home, 'default', 'blank-marker')).toMatchObject({
      status: 'error',
    });
    expect(await readdir(inFlightDir())).toEqual([]);
  });

  it('writes the marker before the first running record lands', async () => {
    const run = record('ordered', '2026-09-27T10:00:00.000Z', 'running');
    await writeProjectScriptRun(home, run);
    expect(await readFile(join(inFlightDir(), 'ordered'), 'utf8')).toBe('2026-09-27');
    const file = projectScriptRunFile(home, 'default', '2026-09-27', 'ordered');
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ status: 'running' });
  });
});
