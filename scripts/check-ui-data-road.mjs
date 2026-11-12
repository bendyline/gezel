#!/usr/bin/env node

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(root, 'scripts', 'ui-data-road-baseline.json');

/**
 * The UI has one way to read server state, poll, announce a change and wait
 * (docs/ui-architecture.md). Older code predates each rule, so this is a
 * ratchet like check-module-size.mjs: every file may keep at most the count
 * recorded in scripts/ui-data-road-baseline.json, and a new file starts at
 * zero. Converting old code lowers a count; `--update` writes the lower
 * baseline. Raising a count is the thing this exists to stop.
 */
export const RULES = Object.freeze([
  {
    id: 'cached-read',
    why: 'reads a shared read through `api` directly; use useApiRead / peekRead from data/',
    pattern:
      /\bapi\.(?:getConfig|listGezels|listProjects|getProject|listProjectAttachments|listChatSessions|getQueueStatus|listInflightTurns|getUsage|getSystemHomeInfo)\(/g,
    allow: [/^packages\/ui\/src\/data\//],
  },
  {
    id: 'interval',
    why: 'polls with setInterval; use useApiRead({ pollMs }) or setVisibleInterval',
    pattern: /\b(?:window\.)?setInterval\(/g,
    allow: [/^packages\/ui\/src\/visible-interval\.ts$/],
  },
  {
    id: 'config-event',
    why: 'listens for gezel:config-updated; read config with useConfig instead',
    pattern: /addEventListener\(\s*['"]gezel:config-updated['"]/g,
    allow: [/^packages\/ui\/src\/data\//],
  },
  {
    id: 'stream-loop',
    why: 'a for-await loop in a component keeps React Compiler from compiling it; use useAllChatEvents or forEachEvent',
    pattern: /\bfor await \(/g,
    allow: [/^packages\/ui\/src\/(?:reconnecting-stream|shared-chat-events)\.ts$/, /\.ts$/],
  },
  {
    id: 'loading-text',
    why: 'says "Loading…"; hold the frame instead (PaneFrame, "Loading states" in docs/ux.md)',
    pattern: />\s*Loading(?:…|\.\.\.)\s*</g,
    allow: [],
  },
]);

async function walk(directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'test-utils' && entry.name !== 'node_modules') await walk(path, files);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      files.push(path);
    }
  }
}

/** Counts per rule per file, for the files that break a rule at least once. */
export function countViolations(sources, rules = RULES) {
  const counts = {};
  for (const rule of rules) counts[rule.id] = {};
  for (const [file, source] of Object.entries(sources)) {
    for (const rule of rules) {
      if (rule.allow.some((pattern) => pattern.test(file))) continue;
      const found = source.match(rule.pattern)?.length ?? 0;
      if (found > 0) counts[rule.id][file] = found;
    }
  }
  return counts;
}

/** Failures for counts above the baseline, and notes for counts below it. */
export function compareWithBaseline(counts, baseline, rules = RULES) {
  const failures = [];
  const lowered = [];
  for (const rule of rules) {
    const now = counts[rule.id] ?? {};
    const was = baseline[rule.id] ?? {};
    for (const [file, count] of Object.entries(now)) {
      const allowed = was[file] ?? 0;
      if (count > allowed) {
        failures.push(`${file}: ${count} × ${rule.id} (baseline ${allowed}) — ${rule.why}`);
      }
    }
    for (const [file, count] of Object.entries(was)) {
      if ((now[file] ?? 0) < count)
        lowered.push(`${file}: ${rule.id} ${count} → ${now[file] ?? 0}`);
    }
  }
  return { failures, lowered };
}

async function main() {
  const files = [];
  await walk(join(root, 'packages', 'ui', 'src'), files);
  const sources = {};
  for (const file of files) {
    sources[relative(root, file).replaceAll('\\', '/')] = await readFile(file, 'utf8');
  }
  const counts = countViolations(sources);
  if (process.argv.includes('--update')) {
    await writeFile(BASELINE, `${JSON.stringify(counts, null, 2)}\n`);
    process.stdout.write(`UI data road: baseline written to ${relative(root, BASELINE)}\n`);
    return;
  }
  const baseline = JSON.parse(await readFile(BASELINE, 'utf8'));
  const { failures, lowered } = compareWithBaseline(counts, baseline);
  if (lowered.length > 0) {
    process.stdout.write(
      `UI data road: ${lowered.length} count(s) went down; run \`node scripts/check-ui-data-road.mjs --update\` to lock them in:\n  ${lowered.join('\n  ')}\n`,
    );
  }
  if (failures.length > 0) {
    process.stderr.write(`UI data road failed:\n  ${failures.join('\n  ')}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
