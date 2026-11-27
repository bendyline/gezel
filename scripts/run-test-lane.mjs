#!/usr/bin/env node
/**
 * One CI runner's share of the test suites: `pnpm test:lane <lane>`.
 *
 * The pull-request gate runs three passes over the UI and service suites
 * (quality.yml `suites`), each split across runners by these lanes, and runs
 * every other package once (`packages`, in the `unit` job). Run one after
 * another, the lanes run exactly what `pnpm test:ci` runs; the release gate
 * still uses `test:ci` and `test:stability`, which run on one runner.
 * run-test-lane.test.mjs checks that the lanes cover every package and every
 * service project exactly once.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnPnpmSync } from './pnpm-cli.mjs';

const SERVICE = '@bendyline/gezel-service';
const UI = '@bendyline/gezel-ui';

/** Each lane is a list of pnpm argument lists, run in order. */
export const LANES = {
  packages: [
    [
      '-r',
      '--workspace-concurrency=1',
      '--filter',
      '@bendyline/gezel*',
      '--filter',
      '@bendyline/gezk*',
      '--filter',
      `!${SERVICE}`,
      '--filter',
      `!${UI}`,
      'run',
      'test',
    ],
  ],
  'service-unit': [
    ['--filter', SERVICE, 'exec', 'vitest', 'run', '--project', 'unit', '--project', 'fs-events'],
  ],
  'service-integration-chat': [
    ['--filter', SERVICE, 'exec', 'vitest', 'run', '--project', 'integration-chat'],
  ],
  'service-integration': [
    ['--filter', SERVICE, 'exec', 'vitest', 'run', '--project', 'integration'],
  ],
  // The CLI's interaction-heavy TUI suite rides with the UI: every stability
  // pass repeats it (test:stability:tui), and it takes seconds.
  ui: [
    ['--filter', UI, 'run', 'test'],
    ['--filter', '@bendyline/gezel-cli', 'exec', 'vitest', 'run', 'src/tui/App.test.tsx'],
  ],
};

/**
 * With TEST_TIMINGS_DIR set, each vitest run also writes its JSON report
 * there, so CI keeps per-file timings for balancing the lanes. The default
 * reporter stays, so the log reads as before.
 */
export function withTimings(name, index, args, timingsDir = process.env.TEST_TIMINGS_DIR) {
  if (!timingsDir || !args.includes('vitest')) return args;
  const file = resolve(timingsDir, `${name}-${index}.json`).replaceAll('\\', '/');
  return [...args, '--reporter=default', '--reporter=json', `--outputFile.json=${file}`];
}

export function runLane(name, spawn = spawnPnpmSync) {
  const commands = LANES[name];
  if (!commands) {
    console.error(
      `[test:lane] unknown lane "${name}"; expected one of: ${Object.keys(LANES).join(', ')}`,
    );
    return 2;
  }
  for (const [index, lane] of commands.entries()) {
    const args = withTimings(name, index, lane);
    console.log(`[test:lane] ${name}: pnpm ${args.join(' ')}`);
    const result = spawn(args, { stdio: 'inherit' });
    if (result.error) {
      console.error(`[test:lane] ${name}: ${result.error.message}`);
      return 1;
    }
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exit(runLane(process.argv[2]));
}
