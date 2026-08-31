#!/usr/bin/env node
// Refresh docs/handboek/og-headlines.json — the committed poster headlines the
// static-site export stamps onto each page's Open Graph card.
//
// This is deliberately NOT part of `pnpm docs:site`. Distilling needs a model,
// and a docs publish has to work offline, on any machine, with no provider
// configured. The build only ever reads the committed lockfile; this script is
// what puts entries in it, run occasionally by a human who reads the diff.
//
// Only hand-authored articles are distilled. Catalog pages (craftbooks, roles,
// project types) use their own name as the headline, which is already the card
// we want for them.
//
//   node scripts/distill-og-headlines.mjs           # refresh stale entries
//   node scripts/distill-og-headlines.mjs --check   # report staleness, write nothing
//   node scripts/distill-og-headlines.mjs --all     # redo every entry
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);

const CONTENT_DIR = join(repoRoot, 'docs', 'handboek');
const LOCKFILE = join(CONTENT_DIR, 'og-headlines.json');
const CLI_ENTRY = join(repoRoot, 'packages', 'cli', 'dist', 'bin', 'gezel.js');
const SERVICE_HANDBOEK = join(repoRoot, 'packages', 'service', 'dist', 'handboek.js');
// Imported by path, not by name: this script runs from the repo root, which is
// not a package that depends on the workspace libraries.
const CATALOG_ENTRY = join(repoRoot, 'packages', 'catalog', 'dist', 'index.js');

// Small batches: one model call per batch keeps round trips down while staying
// far short of any output cap, so a reply is never truncated mid-JSON.
const BATCH = 8;
const MAX_CHARS = 80;

if (flag('--help') || flag('-h')) {
  console.log(`Usage: node scripts/distill-og-headlines.mjs [--check] [--all]

  --check  report stale/missing entries and exit non-zero; writes nothing
  --all    re-distill every article, not just the stale ones
`);
  process.exit(0);
}

for (const [label, path] of [
  ['service', SERVICE_HANDBOEK],
  ['CLI', CLI_ENTRY],
  ['catalog', CATALOG_ENTRY],
]) {
  if (!existsSync(path)) {
    console.error(`[og-headlines] ${label} not built — missing ${path}`);
    console.error('[og-headlines] run: pnpm --filter @bendyline/gezel-cli... run build');
    process.exit(1);
  }
}

const { createHandboekEngine, hashArticleBody, ogHeadlineSource, siteDeviceInfo } = await import(
  pathToFileURL(SERVICE_HANDBOEK).href
);
const { CatalogService } = await import(pathToFileURL(CATALOG_ENTRY).href);

const engine = createHandboekEngine({
  catalog: new CatalogService(),
  device: siteDeviceInfo,
  contentDir: CONTENT_DIR,
});
const toc = await engine.toc();

// Hand-authored only. `generated` marks the catalog-derived articles.
const candidates = toc.areas
  .flatMap((a) => a.entries)
  .filter((e) => !e.generated && e.siteVisible !== false);

const lock = existsSync(LOCKFILE)
  ? JSON.parse(await readFile(LOCKFILE, 'utf8'))
  : { version: 1, entries: {} };
lock.entries ??= {};

const stale = candidates.filter((entry) => {
  if (flag('--all')) return true;
  const record = lock.entries[entry.id];
  return !record || record.sourceHash !== hashArticleBody(ogHeadlineSource(entry));
});

console.log(`[og-headlines] ${candidates.length} hand-authored articles, ${stale.length} stale`);

if (flag('--check')) {
  for (const entry of stale) console.error(`  stale: ${entry.id}`);
  if (stale.length > 0) {
    console.error('[og-headlines] run `pnpm docs:og-headlines` to refresh them');
    console.error('[og-headlines] until then those pages fall back to their title');
  }
  process.exit(stale.length > 0 ? 1 : 0);
}

if (stale.length === 0) {
  console.log('[og-headlines] nothing to do');
  process.exit(0);
}

// An article the model skips, or answers unusably, keeps whatever it had. A
// missing entry costs a duller card, never a wrong one.
let written = 0;
for (let i = 0; i < stale.length; i += BATCH) {
  const batch = stale.slice(i, i + BATCH);
  console.log(`[og-headlines] distilling ${i + 1}-${i + batch.length} of ${stale.length}…`);
  let headlines;
  try {
    headlines = distill(batch);
  } catch (err) {
    console.error(`[og-headlines] batch failed, keeping existing entries: ${err.message}`);
    continue;
  }
  for (const entry of batch) {
    const headline = clean(headlines[entry.id]);
    if (!headline) {
      console.error(`  no usable headline for ${entry.id} — leaving it to fall back`);
      continue;
    }
    lock.entries[entry.id] = {
      sourceHash: hashArticleBody(ogHeadlineSource(entry)),
      headline,
    };
    written += 1;
    console.log(`  ${entry.id}: ${headline}`);
  }
}

// Drop entries for articles that no longer exist, and sort so the committed
// diff is about content rather than key order.
const live = new Set(candidates.map((e) => e.id));
const sorted = {};
for (const id of Object.keys(lock.entries).sort()) {
  if (live.has(id)) sorted[id] = lock.entries[id];
}
await writeFile(LOCKFILE, `${JSON.stringify({ version: 1, entries: sorted }, null, 2)}\n`, 'utf8');
console.log(`[og-headlines] wrote ${written} headlines → ${LOCKFILE}`);
console.log('[og-headlines] read the diff before committing — these are the front door');

function clean(value) {
  if (typeof value !== 'string') return null;
  let text = value.replace(/\s+/g, ' ').trim();
  const quoted = text.length > 1 && text.startsWith('"') && text.endsWith('"');
  if (quoted) text = text.slice(1, -1).trim();
  if (!text || text.length > MAX_CHARS) return null;
  return text;
}

/** One model call for a batch, through the CLI's own connection handling. */
function distill(batch) {
  const result = spawnSync(process.execPath, [CLI_ENTRY, 'run', buildPrompt(batch)], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const tail = (result.stderr ?? '').trim().split('\n').slice(-3).join(' ');
    throw new Error(tail || 'gezel run failed');
  }
  return parseJsonObject(result.stdout ?? '');
}

function buildPrompt(batch) {
  const items = batch
    .map((e) => `- id: ${e.id}\n  title: ${e.title}\n  summary: ${e.summary ?? '(none)'}`)
    .join('\n');
  return `You are writing the headline for a social preview card — the one line someone sees when a documentation link is shared. Below are ${batch.length} articles from the Gezel Handboek.

${items}

For each article, write ONE headline.

Rules:
- Under ${MAX_CHARS} characters. Shorter is better; aim for 30-50.
- Say what the reader gets, in plain language. It is the whole card, set very large.
- No title case, no trailing ellipsis, no surrounding quotes, no emoji.
- Do not repeat the article's own title or a version number — the card shows those already.
- Ground it in the title and summary given. Never invent a feature.

Return ONLY a JSON object mapping each id to its headline, with no prose and no code fence:
{"<id>": "<headline>"}`;
}

/** The reply should be bare JSON; tolerate a fence or surrounding prose. */
function parseJsonObject(raw) {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in the reply');
  return JSON.parse(body.slice(start, end + 1));
}
