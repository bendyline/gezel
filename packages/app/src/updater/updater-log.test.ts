import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'electron-updater';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PREVIOUS_UPDATER_LOG_FILE, UPDATER_LOG_FILE, createUpdaterLog } from './updater-log.js';

const now = () => new Date('2026-10-29T23:22:28.128Z');

describe('updater log', () => {
  let directory = '';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'gezel-updater-log-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps electron-updater messages and raw errors in a log folder it creates', async () => {
    const logs = join(directory, 'logs');
    const log = createUpdaterLog(logs, { now });

    log.info('Checking for update');
    log.error(new Error('Command failed: powershell.exe'));

    const lines = (await readFile(join(logs, UPDATER_LOG_FILE), 'utf8')).split('\n');
    expect(lines[0]).toBe('2026-10-29T23:22:28.128Z INFO Checking for update');
    expect(lines[1]).toMatch(
      /^2026-10-29T23:22:28\.128Z ERROR Error: Command failed: powershell\.exe/,
    );
    expect(lines.join('\n')).toContain('updater-log.test.ts');
  });

  it('still echoes each message to the console logger', () => {
    const echo: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const log = createUpdaterLog(directory, { now, echo });

    log.warn('Cannot download differentially');

    expect(echo.warn).toHaveBeenCalledWith('Cannot download differentially');
    expect(echo.info).not.toHaveBeenCalled();
  });

  it('starts a fresh log once the current one passes 1 MiB, keeping one previous', async () => {
    const oversized = 'x'.repeat(1024 * 1024 + 1);
    await writeFile(join(directory, UPDATER_LOG_FILE), oversized);

    createUpdaterLog(directory, { now }).warn('fresh');

    expect(await readFile(join(directory, PREVIOUS_UPDATER_LOG_FILE), 'utf8')).toBe(oversized);
    expect(await readFile(join(directory, UPDATER_LOG_FILE), 'utf8')).toBe(
      '2026-10-29T23:22:28.128Z WARN fresh\n',
    );
  });

  it('never throws when the log cannot be written', async () => {
    // A file where the folder should be makes every write fail.
    const blocked = join(directory, 'not-a-folder');
    await writeFile(blocked, '');
    const log = createUpdaterLog(blocked, { now });
    expect(() => log.error('still fine')).not.toThrow();
  });
});
