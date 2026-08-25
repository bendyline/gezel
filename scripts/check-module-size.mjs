#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Every TypeScript module under packages/*/src must stay under the flat
// threshold. Files that were already larger when the universal walk was
// introduced are grandfathered at their then-measured size — a ratchet, not an
// allowance: tight headroom bounds further growth, and shrinking a file past
// the slack (or under the threshold) fails the guard until its entry is
// lowered or removed in the same change, so improvements are locked in.
export const FLAT_THRESHOLD = 3_000;
export const HEADROOM_MULTIPLIER = 1.05;

export const GRANDFATHERED = new Map([
  ['packages/service/src/chat/manager.ts', 17_956],
  ['packages/mcp/src/server.ts', 12_293],
  ['packages/service/src/providers/llama-cpp/provider.test.ts', 10_290],
  ['packages/client/src/client.ts', 8_172],
  ['packages/service/src/fs/store.ts', 7_204],
  ['packages/service/src/providers/llama-cpp/provider.ts', 7_166],
  ['packages/core/src/schemas/api.ts', 7_046],
  ['packages/service/src/chat/manager.test.ts', 7_045],
  ['packages/ui/src/views/SettingsView.tsx', 4_706],
  ['packages/service/src/tasks/manager.ts', 4_518],
  ['packages/ui/src/components/ChatTimelineView.tsx', 4_285],
  ['packages/ui/src/views/ProjectsView.tsx', 4_114],
  ['packages/ui/src/components/chat-bubbles.tsx', 3_802],
  ['packages/service/src/providers/mlx/provider.ts', 3_795],
  ['packages/service/src/providers/local-tool-call-salvage.ts', 3_643],
  ['packages/service/src/index-store/index-store.ts', 3_473],
  ['packages/service/src/service.ts', 3_459],
  ['packages/app/src/main.ts', 3_188],
]);

const IGNORED_DIRS = new Set(['dist', 'node_modules', 'generated', '__snapshots__']);

async function walk(directory, files) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, files);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(path);
  }
}

export function countLines(source) {
  if (source === '') return 0;
  return source.split(/\r?\n/).length - (source.endsWith('\n') ? 1 : 0);
}

export async function checkModuleSizes({
  rootDir = root,
  threshold = FLAT_THRESHOLD,
  headroom = HEADROOM_MULTIPLIER,
  grandfathered = GRANDFATHERED,
} = {}) {
  const files = [];
  let packageDirs = [];
  try {
    packageDirs = (await readdir(join(rootDir, 'packages'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(rootDir, 'packages', entry.name, 'src'));
  } catch {
    // No packages directory: the walk finds nothing and only stale-entry
    // failures below can fire.
  }
  for (const dir of packageDirs) await walk(dir, files);

  const failures = [];
  const seen = new Set();
  for (const path of files) {
    const key = relative(rootDir, path).replaceAll('\\', '/');
    seen.add(key);
    const lines = countLines(await readFile(path, 'utf8'));
    const baseline = grandfathered.get(key);
    if (baseline === undefined) {
      if (lines > threshold) {
        failures.push(
          `${key}: ${lines} lines exceeds the ${threshold}-line threshold; extract a focused module`,
        );
      }
      continue;
    }
    const ceiling = Math.floor(baseline * headroom);
    if (lines > ceiling) {
      failures.push(
        `${key}: ${lines} lines exceeds its grandfathered ceiling ${ceiling} (baseline ${baseline}); extract a focused module`,
      );
    } else if (lines <= threshold) {
      failures.push(
        `${key}: ${lines} lines is under the ${threshold}-line threshold; remove its grandfather entry to lock the improvement in`,
      );
    } else if (lines < Math.floor(baseline / headroom)) {
      failures.push(
        `${key}: ${lines} lines is well under its baseline ${baseline}; lower the baseline to ${lines} to lock the improvement in`,
      );
    }
  }
  for (const key of grandfathered.keys()) {
    if (!seen.has(key)) {
      failures.push(`${key}: grandfathered but no longer exists; remove its entry`);
    }
  }
  return failures.sort();
}

export async function main() {
  const failures = await checkModuleSizes();
  if (failures.length > 0) {
    process.stderr.write(
      `Module size guardrail failed:\n${failures.map((line) => `  - ${line}`).join('\n')}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write('Module size guardrail passed.\n');
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) await main();
