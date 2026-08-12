import { createHash } from 'node:crypto';
import { type EnrichDeps, resolveEnrichCompletion } from './enrich.js';
import type { IndexStore } from './index-store.js';

/**
 * Deep-pass tier 2: roll file summaries up into folder ("area") summaries,
 * then roll the areas up into one project-level architecture note. Runs after
 * the file tier has drained (every eligible file has a summary), typically on
 * night shift where the LLM budget is generous.
 *
 * Incrementality mirrors the file tier: each rollup stores the hash of the
 * exact child summaries that fed it, so an unchanged area costs nothing on
 * later sweeps. The whole ladder therefore compounds — file edits invalidate
 * only their own file summary, that area's rollup, and the architecture note.
 */

/** area_summaries sentinel row holding the whole-project architecture note. */
export const ARCHITECTURE_KEY = '::project';

const MIN_AREA_FILES = 2;
const AREA_INPUT_CAP = 6000;
const SUMMARY_CAP = 1200;

export interface AreaPassResult {
  areasUpdated: number;
  architectureUpdated: boolean;
}

export async function runAreaPass(index: IndexStore, deps: EnrichDeps): Promise<AreaPassResult> {
  const result: AreaPassResult = { areasUpdated: 0, architectureUpdated: false };
  const rows = index.fileSummaries();
  if (rows.length === 0) return result;

  const groups = new Map<string, Array<{ path: string; hash: string; summaryMd: string }>>();
  for (const row of rows) {
    const top = row.path.includes('/') ? row.path.slice(0, row.path.indexOf('/')) : '.';
    let group = groups.get(top);
    if (!group) {
      group = [];
      groups.set(top, group);
    }
    group.push(row);
  }

  for (const [area, entries] of groups) {
    if (entries.length < MIN_AREA_FILES) continue;
    const inputHash = hashLines(entries.map((e) => `${e.path}:${e.hash}`));
    if (index.getAreaSummary(area)?.inputHash === inputHash) continue;
    const completion = resolveEnrichCompletion(
      await deps.summarize(buildAreaPrompt(area, entries)),
      deps,
    );
    const summary = completion.text.trim();
    if (!summary) continue;
    index.upsertAreaSummary({
      areaPath: area,
      inputHash,
      summaryMd: summary.slice(0, SUMMARY_CAP),
      model: completion.model,
      ...(completion.provenance ? { provenance: completion.provenance } : {}),
    });
    result.areasUpdated++;
  }

  const areas = index
    .allAreaSummaries()
    .filter((a) => a.areaPath !== ARCHITECTURE_KEY)
    .sort((a, b) => (a.areaPath < b.areaPath ? -1 : 1));
  if (areas.length > 0) {
    const archHash = hashLines(areas.map((a) => `${a.areaPath}:${a.inputHash}`));
    if (index.getAreaSummary(ARCHITECTURE_KEY)?.inputHash !== archHash) {
      const completion = resolveEnrichCompletion(
        await deps.summarize(buildArchitecturePrompt(areas)),
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

function hashLines(lines: string[]): string {
  return createHash('sha256')
    .update([...lines].sort().join('\n'))
    .digest('hex');
}

function buildAreaPrompt(
  area: string,
  entries: Array<{ path: string; summaryMd: string }>,
): string {
  let body = '';
  for (const e of entries) {
    const line = `- ${e.path}: ${e.summaryMd.replace(/\s+/g, ' ').trim()}\n`;
    if (body.length + line.length > AREA_INPUT_CAP) break;
    body += line;
  }
  const label = area === '.' ? 'the project root' : `the "${area}/" folder`;
  return `These are one-line summaries of the files in ${label}:\n\n${body}\nWrite 2-3 sentences describing what this folder is for and how its pieces fit together. Plain prose, no headings, no bullet lists.`;
}

function buildArchitecturePrompt(areas: Array<{ areaPath: string; summaryMd: string }>): string {
  let body = '';
  for (const a of areas) {
    const label = a.areaPath === '.' ? '(root files)' : `${a.areaPath}/`;
    const line = `- ${label}: ${a.summaryMd.replace(/\s+/g, ' ').trim()}\n`;
    if (body.length + line.length > AREA_INPUT_CAP) break;
    body += line;
  }
  return `These are summaries of each top-level folder in a project:\n\n${body}\nWrite a 3-5 sentence architecture overview: what the project is, its main parts, and how they relate. Plain prose, no headings.`;
}
