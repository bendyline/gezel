/**
 * One-shot prompt naturalization over every craftbook `test.json`.
 *
 * Design principle (docs/eval-strategy.md): the CRAFTBOOK carries the
 * rigor; the PROMPT carries the ambiguity. Eval prompts must read like
 * real human asks — short, plain, a little underspecified — not like
 * acceptance criteria. An exacting prompt "leads the witness": it tests
 * instruction-following, when the thing we ship (and therefore measure)
 * is whether the craftbook system turns a casual ask into a quality
 * deliverable. The deterministic checks stay class-level and unchanged —
 * widening the prompt-to-gate gap is the honest test.
 *
 * Two transforms:
 *   1. Books still carrying a generated-template prompt get a fully
 *      plain per-kind prompt (input pointer + output filename in
 *      natural phrasing — things real users actually say — and nothing
 *      else).
 *   2. Every other (hand-tuned) prompt just loses the harness-noise
 *      preamble "Use the X craftbook/template if it is available." —
 *      the harness guarantees installation; bespoke content is
 *      preserved for a by-hand pass later.
 *
 * Run: pnpm --filter @bendyline/gezel-evals exec tsx scripts/naturalize-prompts.ts
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// This script MUTATES craftbook test specs, so it targets the sibling
// gilde working tree (where edits become PRs), not the installed package.
const gildeRoot = process.env.GILDE_DIR?.trim() || join(here, '..', '..', '..', 'gilde');
const templatesRoot = join(gildeRoot, 'data', 'craftbook-templates');

interface TestSpecFile {
  tags?: string[];
  prompt: string;
  setup?: { projectName?: string };
  [key: string]: unknown;
}

/**
 * Plain-language prompts per task class. Input + output named naturally;
 * no criteria lists. Each carries one or two deliberate, natural typos
 * (real asks have them; robustness to crude input is part of the class
 * bar) — in PROSE ONLY, never in file paths or filenames, which must
 * stay exact for fixture discovery.
 */
const PLAIN_PROMPTS: Record<string, (bookName: string) => string> = {
  corpus: (name) =>
    `We need a ${lowerName(name)} for the returns-desk work. The backgound info is in source/brief.md — have a look and write it up in report.md.`,
  data: () =>
    'I dropped our numbers in source/records.csv. Can you look at the data, analyze it, and put togehter some results in analysis.md?',
  'html-page': () =>
    'Can you biuld us a little page for this? The content notes are in source/page-content.md. Save it as index.html — one file, nothing fancy needed on our end.',
  'html-game': () =>
    'Make us a fun litle browser game around the returns-desk theme — just one file, index.html, that we can open and play.',
  code: () =>
    'We need a small Node helper for this — the requirments are in source/requirements.md. Put it in src/solution.mjs.',
  media: () =>
    'Our media files are all listd in source/media-index.csv. Can you put together the production plan for them as media-plan.json?',
  external: () =>
    'Theres a fake service set up for this so nothing real gets touched — details are in fixtures/fake-service.md. Can you work out the automation and write up how it woudl run in automation.md?',
};

function lowerName(name: string): string {
  // "Annual Document Review" → "annual document review"; keep acronyms.
  return name
    .split(' ')
    .map((word) => (word === word.toUpperCase() && word.length > 1 ? word : word.toLowerCase()))
    .join(' ');
}

/** The generated-template fingerprint: full spec-style prompts we replace outright. */
function isGeneratedTemplatePrompt(prompt: string): boolean {
  return (
    prompt.startsWith('Use the ') &&
    (prompt.includes('a self-contained browser game themed around') ||
      prompt.includes('a self-contained page or tool that fits this craftbook') ||
      prompt.includes('a dependency-free Node ESM module for this craftbook') ||
      prompt.includes('an analysis artifact for this craftbook') ||
      prompt.includes('a polished artifact appropriate for this craftbook') ||
      prompt.includes('a valid JSON production manifest for this craftbook') ||
      prompt.includes('a dry-run automation artifact for this craftbook'))
  );
}

const AVAILABILITY_PREAMBLE = /^Use the .{1,80}? craftbook\/template if it is available\.\s*/;

let replaced = 0;
let stripped = 0;
let untouched = 0;
for (const shard of readdirSync(templatesRoot, { withFileTypes: true })) {
  if (!shard.isDirectory()) continue;
  for (const book of readdirSync(join(templatesRoot, shard.name), { withFileTypes: true })) {
    if (!book.isDirectory()) continue;
    const versionsDir = join(templatesRoot, shard.name, book.name, 'versions');
    let versions: string[];
    try {
      versions = readdirSync(versionsDir);
    } catch {
      continue;
    }
    for (const version of versions) {
      const file = join(versionsDir, version, 'test.json');
      let spec: TestSpecFile;
      try {
        spec = JSON.parse(readFileSync(file, 'utf8')) as TestSpecFile;
      } catch {
        continue;
      }
      const kind = spec.tags?.[0] ?? 'corpus';
      const bookName = (spec.setup?.projectName ?? book.name).replace(/ Eval$/, '');
      let next = spec.prompt;
      if (isGeneratedTemplatePrompt(next) && PLAIN_PROMPTS[kind]) {
        next = PLAIN_PROMPTS[kind]!(bookName);
        replaced++;
      } else if (AVAILABILITY_PREAMBLE.test(next)) {
        next = next.replace(AVAILABILITY_PREAMBLE, '');
        stripped++;
      } else {
        untouched++;
        continue;
      }
      spec.prompt = next;
      writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
    }
  }
}
console.log(
  `plain-language rewrite: ${replaced} generated prompts replaced, ${stripped} preambles stripped, ${untouched} untouched`,
);
