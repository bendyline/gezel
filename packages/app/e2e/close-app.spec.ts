import { expect, test } from '@playwright/test';
import { closeApp } from './helpers/close-app.js';

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
