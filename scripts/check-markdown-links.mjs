#!/usr/bin/env node
/** Fail when a checked-in Markdown link points at a missing local path. */
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const ignoredDirectories = new Set([
  '.git',
  '.cache',
  '.upstream',
  'coverage',
  'dist',
  'node_modules',
]);
// `.gezel/craftbooks` holds craftbook copies synced verbatim out of
// `.claude/skills/*/SKILL.md`. Their relative links resolve from the skill
// directory, not from the copy, so checking them only ever reports the sync.
const ignoredRepoDirectories = new Set([
  '.gezel/craftbooks',
  'artifacts',
  'evals/runs',
  'reports',
  'runs',
  'ship-audit',
]);

async function markdownFiles(root) {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (
        entry.isDirectory() &&
        (ignoredDirectories.has(entry.name) ||
          ignoredRepoDirectories.has(relative(repoRoot, path).split(sep).join('/')))
      ) {
        continue;
      }
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
    }
  }
  await walk(root);
  return files;
}

function localTarget(raw) {
  let href = raw.trim().replace(/^<|>$/g, '');
  if (!href || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  href = href.split('#')[0].split('?')[0];
  return href ? decodeURIComponent(href) : null;
}

async function main() {
  const files = await markdownFiles(repoRoot);
  const broken = [];
  for (const file of files) {
    const markdown = await readFile(file, 'utf8');
    for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = localTarget(match[1]);
      if (!target) continue;
      const path = resolve(dirname(file), target);
      try {
        await stat(path);
      } catch {
        broken.push(`${relative(repoRoot, file)} -> ${match[1]}`);
      }
    }
  }
  if (broken.length > 0) {
    throw new Error(
      `broken local Markdown links:\n${broken.map((item) => `  - ${item}`).join('\n')}`,
    );
  }
  console.log(`\u2713 local Markdown links resolve (${files.length} files).`);
}

main().catch((error) => {
  console.error(`\u2717 Markdown link check failed: ${error.message}`);
  process.exitCode = 1;
});
