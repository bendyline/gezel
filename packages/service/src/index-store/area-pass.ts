import { createHash } from 'node:crypto';
import { type EnrichDeps, resolveEnrichCompletion } from './enrich.js';
import type { IndexStore } from './index-store.js';

/**
 * Deep-pass tier 2: roll file summaries up into folder ("area") summaries,
 * then roll the top-level areas up into one project-level architecture note.
 * Runs after the file tier has drained (every eligible file has a summary),
 * typically on night shift where the LLM budget is generous.
 *
 * Areas follow the folder tree. A folder with at most `SPLIT_ABOVE`
 * summarized files is one area, summarized from its files; a larger one is
 * mapped through its subfolders first and then summarized from their
 * summaries and its own loose files. Every folder on the way up therefore
 * gets a purpose (the file map and file insight read the nearest one), and a
 * large top-level folder is described from its parts instead of from the
 * first few thousand characters of its files. Grouping by top-level folder
 * alone gave squisq one area for 1,700 files (harness experiment, 2026-10-21).
 *
 * Incrementality mirrors the file tier: each rollup stores the hash of the
 * exact inputs that fed it, so an unchanged area costs nothing on later
 * sweeps. A file edit invalidates its own file summary, the areas above it,
 * and the architecture note.
 */

/** area_summaries sentinel row holding the whole-project architecture note. */
export const ARCHITECTURE_KEY = '::project';

const MIN_AREA_FILES = 2;
/** A folder with more summarized files than this is mapped through its subfolders. */
const SPLIT_ABOVE = 30;
/**
 * Tests, fixtures, vendored code, samples and translations stay one area
 * however large: split, a copy of jQuery UI's demos under Brackets' test
 * files became 30 areas of its own, test/ another 89, and its 40-language
 * nls/ and samples/ folders 52 more (2026-10-21).
 */
const NEVER_SPLIT =
  /^(tests?|specs?|__tests__|__mocks__|e2e|fixtures?|__fixtures__|testdata|test-?files|unittest-files|known-goods|vendor|vendored|third[_-]?party|thirdparty|node_modules|samples?|examples?|demos?|nls|i18n|l10n|locales?|translations?)$|-(test-files|known-goods)$/i;
const AREA_INPUT_CAP = 6000;
const ENTRY_CAP = 300;
const SUMMARY_CAP = 1600;
/** Salts every input hash, so a change to the prompts below regenerates each area once. */
const AREA_PROMPT_VERSION = 'v3';

export interface AreaPassResult {
  areasUpdated: number;
  architectureUpdated: boolean;
}

interface FileRow {
  path: string;
  hash: string;
  summaryMd: string;
}

interface FolderNode {
  path: string;
  files: FileRow[];
  children: Map<string, FolderNode>;
  total: number;
}

/** The part of an area summary that says what the folder is for: its first paragraph. */
export function areaPurpose(summaryMd: string): string {
  return summaryMd
    .trim()
    .split(/\n\s*\n/)[0]!
    .replace(/\s+/g, ' ')
    .trim();
}

/** The key files or subfolders an area summary lists as `- <path> — <what it is for>` lines. */
export function areaKeyFiles(summaryMd: string): Array<{ path: string; purpose: string }> {
  const out: Array<{ path: string; purpose: string }> = [];
  for (const line of summaryMd.split('\n')) {
    const m = /^\s*[-*]\s+`?([^`\s]+?)`?\s*(?:—|–|:|\s-)\s*(.+)$/.exec(line);
    if (m) out.push({ path: m[1]!, purpose: m[2]!.trim() });
  }
  return out;
}

export async function runAreaPass(index: IndexStore, deps: EnrichDeps): Promise<AreaPassResult> {
  const result: AreaPassResult = { areasUpdated: 0, architectureUpdated: false };
  const rows = index.fileSummaries();
  if (rows.length === 0) return result;

  const root = buildTree(rows);
  const live = new Set<string>();

  const summarize = async (
    area: string,
    inputHash: string,
    prompt: string,
  ): Promise<{ summaryMd: string; inputHash: string } | null> => {
    live.add(area);
    const existing = index.getAreaSummary(area);
    if (existing?.inputHash === inputHash) return existing;
    const completion = resolveEnrichCompletion(
      await deps.summarize(prompt, `Mapping ${area}`),
      deps,
    );
    const summary = completion.text.trim();
    if (!summary) return existing ?? null;
    index.upsertAreaSummary({
      areaPath: area,
      inputHash,
      summaryMd: summary.slice(0, SUMMARY_CAP),
      model: completion.model,
      ...(completion.provenance ? { provenance: completion.provenance } : {}),
    });
    result.areasUpdated++;
    return { summaryMd: summary, inputHash };
  };

  /** Summarize a folder and, when it is large, its subfolders first. */
  const mapFolder = async (
    node: FolderNode,
  ): Promise<{ summaryMd: string; inputHash: string } | null> => {
    if (node.total < MIN_AREA_FILES) return null;
    const name = node.path.slice(node.path.lastIndexOf('/') + 1);
    if (node.total <= SPLIT_ABOVE || node.children.size === 0 || NEVER_SPLIT.test(name)) {
      const files = allFiles(node);
      return summarize(
        node.path,
        hashLines([AREA_PROMPT_VERSION, ...files.map((f) => `${f.path}:${f.hash}`)]),
        buildAreaPrompt(node.path, files),
      );
    }
    const parts: Array<{ path: string; text: string; key: string }> = [];
    for (const child of sorted(node.children)) {
      const area = await mapFolder(child);
      if (area) {
        parts.push({
          path: `${child.path}/`,
          text: areaPurpose(area.summaryMd),
          key: `area:${child.path}:${area.inputHash}`,
        });
      } else {
        for (const f of allFiles(child))
          parts.push({ path: f.path, text: f.summaryMd, key: `${f.path}:${f.hash}` });
      }
    }
    for (const f of node.files)
      parts.push({ path: f.path, text: f.summaryMd, key: `${f.path}:${f.hash}` });
    return summarize(
      node.path,
      hashLines([AREA_PROMPT_VERSION, ...parts.map((p) => p.key)]),
      buildRollupPrompt(node.path, parts),
    );
  };

  // The root's own files are the "." area; each top-level folder is mapped on its own.
  if (root.files.length >= MIN_AREA_FILES) {
    await summarize(
      '.',
      hashLines([AREA_PROMPT_VERSION, ...root.files.map((f) => `${f.path}:${f.hash}`)]),
      buildAreaPrompt('.', root.files),
    );
  }
  for (const child of sorted(root.children)) await mapFolder(child);

  const stale = index
    .allAreaSummaries()
    .map((a) => a.areaPath)
    .filter((path) => path !== ARCHITECTURE_KEY && !live.has(path));
  index.deleteAreaSummaries(stale);

  const topLevel = index
    .allAreaSummaries()
    .filter((a) => a.areaPath !== ARCHITECTURE_KEY && !a.areaPath.includes('/'))
    .sort((a, b) => (a.areaPath < b.areaPath ? -1 : 1));
  if (topLevel.length > 0) {
    const archHash = hashLines([
      AREA_PROMPT_VERSION,
      ...topLevel.map((a) => `${a.areaPath}:${a.inputHash}`),
    ]);
    if (index.getAreaSummary(ARCHITECTURE_KEY)?.inputHash !== archHash) {
      const completion = resolveEnrichCompletion(
        await deps.summarize(buildArchitecturePrompt(topLevel), 'Mapping the project'),
        deps,
      );
      const note = completion.text.trim();
      if (note) {
        index.upsertAreaSummary({
          areaPath: ARCHITECTURE_KEY,
          inputHash: archHash,
          summaryMd: note.slice(0, SUMMARY_CAP),
          model: completion.model,
          ...(completion.provenance ? { provenance: completion.provenance } : {}),
        });
        result.architectureUpdated = true;
      }
    }
  }

  return result;
}

function buildTree(rows: FileRow[]): FolderNode {
  const root: FolderNode = { path: '', files: [], children: new Map(), total: 0 };
  for (const row of rows) {
    const dirs = row.path.split('/').slice(0, -1);
    let node = root;
    node.total++;
    for (const dir of dirs) {
      let child = node.children.get(dir);
      if (!child) {
        child = {
          path: node.path ? `${node.path}/${dir}` : dir,
          files: [],
          children: new Map(),
          total: 0,
        };
        node.children.set(dir, child);
      }
      node = child;
      node.total++;
    }
    node.files.push(row);
  }
  return root;
}

function allFiles(node: FolderNode): FileRow[] {
  const out = [...node.files];
  for (const child of sorted(node.children)) out.push(...allFiles(child));
  return out;
}

function sorted(children: Map<string, FolderNode>): FolderNode[] {
  return [...children.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

function hashLines(lines: string[]): string {
  return createHash('sha256')
    .update([...lines].sort().join('\n'))
    .digest('hex');
}

function entries(lines: Array<{ path: string; text: string }>): string {
  let body = '';
  for (const e of lines) {
    const line = `- ${e.path}: ${e.text.replace(/\s+/g, ' ').trim().slice(0, ENTRY_CAP)}\n`;
    if (body.length + line.length > AREA_INPUT_CAP) break;
    body += line;
  }
  return body;
}

const SHAPE =
  'Line 1: one sentence saying what this folder is for, in the words someone looking for it would search with, starting with the verb that best says what it does.\nThen a blank line and';

function buildAreaPrompt(area: string, files: FileRow[]): string {
  const label = area === '.' ? 'the project root' : `the "${area}/" folder`;
  return `These are summaries of the files in ${label}:\n\n${entries(files.map((f) => ({ path: f.path, text: f.summaryMd })))}\n${SHAPE} its most important files, at most 8, one per line as \`- <path> — <what it is for, under 20 words>\`. Use only the paths listed. No headings, no preamble.`;
}

function buildRollupPrompt(area: string, parts: Array<{ path: string; text: string }>): string {
  return `These are the subfolders and files directly inside the "${area}/" folder, with what each is for:\n\n${entries(parts)}\n${SHAPE} the subfolders and files that matter most, at most 8, one per line as \`- <path> — <what it is for, under 20 words>\`. Use only the paths listed. No headings, no preamble.`;
}

function buildArchitecturePrompt(areas: Array<{ areaPath: string; summaryMd: string }>): string {
  const body = entries(
    areas.map((a) => ({
      path: a.areaPath === '.' ? '(root files)' : `${a.areaPath}/`,
      text: areaPurpose(a.summaryMd),
    })),
  );
  return `These are summaries of each top-level folder in a project:\n\n${body}\nWrite a 3-5 sentence architecture overview: what the project is, its main parts, and how they relate. Plain prose, no headings.`;
}
