#!/usr/bin/env node

/**
 * Roles a person reads are plain English; the Meester is the one Dutch title.
 *
 * Code keeps the Dutch keys (`voormanGezelId`, `'boekwachter'` template ids,
 * `klerk.changed` history kinds), and the people who write UI copy read those
 * keys all day, so the old titles drift back into labels by habit. This guard
 * reads the UI and CLI sources and fails on a Dutch role title in text a
 * person can see: string literals and JSX text.
 *
 * A title counts as prose when it is capitalized ("Boekwachter changed") or
 * follows an article, a dash, a quote or a JSX `>` ("the voorman",
 * "— voorman", "'klerk updated'", ">voorman<"). Not flagged: comments;
 * identifiers (`voormanGezelId`, `BoekwachterPill`, `const klerk`); a
 * lowercase literal that is exactly one key (`=== 'voorman'`), which is
 * logic; and dotted,
 * dashed or slashed ids (`project.voorman.changed`, `role/voorman`). A line
 * that genuinely needs the word says why in a trailing
 * `// role-name-exempt: <reason>`.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['packages/ui/src', 'packages/cli/src'];
const WORD = String.raw`(?:voorman|voormannen|voormen|boekwachter|klerk|keurmeester)`;
const TITLE = new RegExp(String.raw`(?<![\w.\-/=@])${WORD}(?![\w.\-/])`, 'gi');
const BARE_KEY = new RegExp(String.raw`^(['"\x60])${WORD}\1$`, 'i');
const PROSE_BEFORE = /(?:\b(?:the|a|an|no|your|and|or|new|of|as|to|with)\s+|—\s*|>\s*|['"`(])$/i;

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (/\.(?:ts|tsx)$/.test(entry.name) && !/\.(?:test|spec)\.tsx?$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Blank out comment lines and trailing `// …` comments. Line-based on
 * purpose: tracking quotes through JSX text breaks on its apostrophes.
 */
function stripComments(source) {
  let inBlock = false;
  return source
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (inBlock) {
        if (trimmed.includes('*/')) inBlock = false;
        return '';
      }
      if (trimmed.startsWith('/*') || trimmed.startsWith('{/*')) {
        if (!trimmed.includes('*/')) inBlock = true;
        return '';
      }
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return '';
      return line.replace(/\s\/\/\s.*$/, '');
    })
    .join('\n');
}

const rel = (p) => relative(root, p).replaceAll('\\', '/');
const failures = [];

for (const dir of ROOTS) {
  for (const file of await walk(resolve(root, dir))) {
    const raw = await readFile(file, 'utf8');
    const rawLines = raw.split('\n');
    const lines = stripComments(raw).split('\n');
    lines.forEach((line, index) => {
      if (rawLines[index]?.includes('role-name-exempt:')) return;
      for (const match of line.matchAll(TITLE)) {
        const before = line[match.index - 1];
        const after = line[match.index + match[0].length];
        const capitalized = match[0][0] !== match[0][0].toLowerCase();
        // A lowercase one-word literal is a key compared in logic; a
        // capitalized one ("?? 'Klerk'") is a fallback a person reads.
        if (!capitalized && before && after && BARE_KEY.test(`${before}${match[0]}${after}`)) {
          continue;
        }
        if (!capitalized && !PROSE_BEFORE.test(line.slice(0, match.index))) continue;
        failures.push(`${rel(file)}:${index + 1}: "${match[0]}" — ${line.trim().slice(0, 120)}`);
      }
    });
  }
}

if (failures.length > 0) {
  console.error(
    'Dutch role titles in text a person can see. Use the plain-English title ' +
      '(Crew Lead, Librarian, Scribe, Inspector; see packages/core/src/roles/plain-names.ts), ' +
      'or add `// role-name-exempt: <reason>`:\n',
  );
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('check-plain-role-names: no Dutch role titles in UI or CLI text');
