/**
 * The perf suite measures the built UI the daemon serves, so a missing or
 * stale build would measure the wrong thing. Unlike the browser suite's
 * setup, this leaves the screenshot gallery alone.
 */
import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const _dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIST_ENTRY = resolve(_dirname, '../../ui/dist/index.html');

export default async function globalSetup(): Promise<void> {
  if (!(await stat(UI_DIST_ENTRY).catch(() => null))) {
    throw new Error('The perf suite measures packages/ui/dist. Run pnpm build first.');
  }
}
