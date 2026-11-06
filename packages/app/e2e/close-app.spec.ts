import { type ChildProcess, spawn } from 'node:child_process';
import { type ElectronApplication, expect, test } from '@playwright/test';
import { closeApp } from './helpers/close-app.js';

/** Playwright's `close()` resolves when the process's stdio closes, as here. */
function appFor(child: ChildProcess): ElectronApplication {
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  return { close: () => closed, process: () => child } as unknown as ElectronApplication;
}

test('closeApp gives the default timeout room for graceful shutdown', async () => {
  test.setTimeout(30_000);
  await closeApp(undefined);
  expect(test.info().timeout).toBe(60_000);
});

test('closeApp preserves a longer restart test budget across both closes', async () => {
  test.setTimeout(150_000);
  await closeApp(undefined);
  expect(test.info().timeout).toBe(150_000);
  await closeApp(undefined);
  expect(test.info().timeout).toBe(150_000);
});

test('closeApp preserves an explicitly disabled timeout', async () => {
  test.setTimeout(0);
  await closeApp(undefined);
  expect(test.info().timeout).toBe(0);
});

test('closeApp kills an app that never exits and fails with its stacks', async () => {
  test.skip(process.platform === 'win32', 'process groups are POSIX');
  const child = spawn('sleep', ['60'], { detached: true, stdio: 'pipe' });
  await expect(closeApp(appFor(child), { exitDeadlineMs: 200 })).rejects.toThrow(
    /still running .* shutdown wall/,
  );
  expect(child.signalCode).toBe('SIGKILL');
  if (process.platform === 'darwin') {
    expect(test.info().attachments.map((a) => a.name)).toContain('electron-main-stacks');
  }
});

test('closeApp cleans up, with a warning, after an app whose output outlived it', async () => {
  test.skip(process.platform === 'win32', 'process groups are POSIX');
  // The shell exits at once; the backgrounded sleep keeps its stdio open.
  const child = spawn('sh', ['-c', 'sleep 60 & exit 0'], { detached: true, stdio: 'pipe' });
  await new Promise((resolve) => child.once('exit', resolve));
  const warn = console.warn;
  console.warn = () => {};
  try {
    await closeApp(appFor(child), { exitDeadlineMs: 200 });
  } finally {
    console.warn = warn;
  }
  expect(test.info().annotations).toContainEqual(
    expect.objectContaining({ type: 'warning', description: expect.stringContaining('sleep 60') }),
  );
});
