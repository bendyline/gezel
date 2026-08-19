import type { MapRepoResponse } from '@bendyline/gezel';

/**
 * Render the "Workspace map" prompt block from the content index's repo
 * gestalt — the deep-pass architecture note, folder purposes, and entry
 * points. Returns '' until the index + area rollups exist, so un-enriched
 * projects pay zero standing tokens. Gated by the `prompt.workspace-gestalt`
 * behavior in buildInstructions; rides the VOLATILE band (index data drifts
 * with the repo, and volatile-band churn never invalidates the stable KV
 * prefix).
 *
 * Budget discipline: purposes are one-line, areas cap at 8, the health line
 * is aggregates-only (~25 tokens, no per-file paths), the whole block lands
 * well under ~330 tokens. Imperative close steers the model to the retrieval
 * tools instead of walking the raw file listing below it.
 */

const MAX_AREAS = 8;
const MAX_ENTRY_POINTS = 6;
const PURPOSE_CAP = 200;
/** Health renders only past this coverage — partial-sweep averages mislead. */
const HEALTH_MIN_COVERAGE = 0.5;

export function renderWorkspaceGestalt(map: MapRepoResponse): string {
  if (!map.indexed) return '';
  const areasWithPurpose = map.areas.filter((a) => a.purpose?.trim());
  if (!map.architecture?.trim() && areasWithPurpose.length === 0) return '';

  const parts: string[] = ['\n\n---\n\n### Workspace map'];
  if (map.architecture?.trim()) {
    parts.push(`\n\n${map.architecture.trim()}`);
  }
  if (areasWithPurpose.length > 0) {
    const lines = areasWithPurpose
      .slice(0, MAX_AREAS)
      .map(
        (a) =>
          `- \`${a.path === '.' ? '(root)' : `${a.path}/`}\` (${a.fileCount} files) — ${oneLine(a.purpose!)}`,
      );
    parts.push(`\n\n${lines.join('\n')}`);
  }
  if (map.entryPoints.length > 0) {
    parts.push(
      `\n\nEntry points: ${map.entryPoints
        .slice(0, MAX_ENTRY_POINTS)
        .map((p) => `\`${p}\``)
        .join(', ')}`,
    );
  }
  const h = map.health;
  if (h && h.eligibleFiles > 0 && h.reviewedFiles >= HEALTH_MIN_COVERAGE * h.eligibleFiles) {
    const issues =
      h.majorIssues > 0 ? `; ${h.majorIssues} major issues — \`list_file_issues\` to see them` : '';
    parts.push(`\n\nHealth: avg ${h.avgHealth}/10 (${h.reviewedFiles} files reviewed)${issues}.`);
  }
  parts.push(
    '\n\nOrient from this map; use `map_repo` for the full picture and `search` to locate specifics across project knowledge.',
  );
  return parts.join('');
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, PURPOSE_CAP);
}
