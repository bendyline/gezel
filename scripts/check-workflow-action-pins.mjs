#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowsDir = join(root, '.github', 'workflows');
const actionsDir = join(root, '.github', 'actions');

// Composite actions pin third-party actions exactly like workflows do, and were
// invisible here until the pnpm setup steps moved into .github/actions/. Scan
// both trees, or moving a `uses:` into a composite silently exempts it.
async function findActionManifests(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const found = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await findActionManifests(path)));
    } else if (entry.name === 'action.yml' || entry.name === 'action.yaml') {
      found.push(path);
    }
  }
  return found;
}

const scanFiles = [
  ...(await readdir(workflowsDir))
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .sort()
    .map((file) => join(workflowsDir, file)),
  ...(await findActionManifests(actionsDir)).sort(),
];

const failures = [];

for (const path of scanFiles) {
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const match = line.match(/^\s*(?:-\s*)?uses:\s*(.+?)\s*$/);
    if (!match) continue;

    const action = match[1]
      .replace(/\s+#.*$/, '')
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');

    // Local composite actions/reusable workflows and Docker images do not use
    // Git commit refs. Every marketplace or repository action must be immutable.
    if (action.startsWith('./') || action.startsWith('docker://')) continue;

    const separator = action.lastIndexOf('@');
    const ref = separator >= 0 ? action.slice(separator + 1) : '';
    if (!/^[0-9a-f]{40}$/i.test(ref)) {
      failures.push(
        `${relative(root, path)}:${index + 1}: ${action} must use a full 40-character commit SHA`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error('GitHub Actions must be pinned to immutable full commit SHAs:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Verified immutable action pins in ${scanFiles.length} workflow and action files.`);
}
