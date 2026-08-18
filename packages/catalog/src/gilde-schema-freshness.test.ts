import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gildePackageRoot } from './gilde-data.js';
import { renderGildeSchemaFiles } from './gilde-schema-export.js';

/**
 * Guards the seam between core's Zod schemas and gilde's committed JSON
 * Schema snapshots. It has no loud failure of its own: gilde's
 * `build-index` normalizes manifests through those snapshots and DROPS
 * any property they don't declare, so content authored against a newer
 * core is silently stripped in the published `index.json` — which is the
 * fast path `BundledSource` serves at runtime. Nothing errors; the field
 * is simply gone, and the daemon falls back to defaults.
 *
 * Wild-caught on three craftbooks at once, each losing an artifact-
 * routing flag that core had declared all along:
 *   pull-request-review  corpusCoverage.artifact
 *   powerpoint-deck      markdownHeadingsMatch.outlineArtifact
 *   invoice-run          spawn.overArtifact
 * The first of those made the whole book unsatisfiable on any project
 * with managed workspace writes off, because the coverage ledger was
 * hunted for in a tree nobody could write.
 *
 * Fails in both directions that matter: editing core without re-running
 * the exporter, and bumping the `@bendyline/gilde` pin to a release cut
 * from an older core.
 */
const FIX = 'Run `pnpm gilde:export-schemas`, then PR the regenerated schemas/ to bendyline/gilde.';

/** Flatten to leaf JSON paths so a diff can name the exact property. */
function leafPaths(value: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (v: unknown, path: string): void => {
    if (v && typeof v === 'object') {
      if (Array.isArray(v)) {
        v.forEach((entry, i) => walk(entry, `${path}[${i}]`));
      } else {
        for (const [key, entry] of Object.entries(v)) walk(entry, `${path}.${key}`);
      }
      return;
    }
    out.set(path, JSON.stringify(v));
  };
  walk(value, '');
  return out;
}

function describeDrift(filename: string, generated: string, committed: string): string {
  let expected: unknown;
  let actual: unknown;
  try {
    expected = JSON.parse(generated);
    actual = JSON.parse(committed);
  } catch {
    return `${filename}: committed copy is not valid JSON.`;
  }
  const gen = leafPaths(expected);
  const com = leafPaths(actual);
  const cap = (paths: string[]): string =>
    paths.length > 10
      ? `${paths.slice(0, 10).join(', ')} … (+${paths.length - 10} more)`
      : paths.join(', ');
  const missing = [...gen.keys()].filter((path) => !com.has(path));
  const orphaned = [...com.keys()].filter((path) => !gen.has(path));
  const changed = [...gen.keys()].filter(
    (path) => com.has(path) && com.get(path) !== gen.get(path),
  );
  const lines = [`${filename}:`];
  if (missing.length > 0) {
    lines.push(
      `  ${missing.length} property path(s) in core but NOT in the committed schema — these are being stripped from the published index: ${cap(missing)}`,
    );
  }
  if (orphaned.length > 0) {
    lines.push(`  ${orphaned.length} committed but no longer generated: ${cap(orphaned)}`);
  }
  if (changed.length > 0) lines.push(`  ${changed.length} changed: ${cap(changed)}`);
  return lines.join('\n');
}

describe('gilde schemas are current with core', () => {
  const root = gildePackageRoot();
  const schemasDir = join(root, 'schemas');

  it('the resolved gilde ships a schemas/ directory', () => {
    // Absent means gilde CI is validating content against nothing, and
    // this whole gate is inert — never let that pass quietly.
    expect(
      existsSync(schemasDir),
      `No schemas/ in the resolved gilde (${root}). The package must ship it — check the "files"/"exports" fields of @bendyline/gilde.`,
    ).toBe(true);
  });

  it('every exported schema matches the committed copy byte for byte', () => {
    const drifted: string[] = [];
    for (const [filename, content] of renderGildeSchemaFiles()) {
      const path = join(schemasDir, filename);
      if (!existsSync(path)) {
        drifted.push(`${filename}: missing from the committed schemas/.`);
        continue;
      }
      const committed = readFileSync(path, 'utf8');
      if (committed === content) continue;
      drifted.push(
        filename.endsWith('.json')
          ? describeDrift(filename, content, committed)
          : `${filename}: differs from the generated copy.`,
      );
    }
    expect(
      drifted,
      `gilde's committed schemas are stale relative to packages/core/src/schemas/.\n\n${drifted.join('\n')}\n\n${FIX}`,
    ).toEqual([]);
  });

  it('carries no orphaned schema files', () => {
    const generated = new Set(renderGildeSchemaFiles().map(([filename]) => filename));
    const orphans = readdirSync(schemasDir)
      .filter((name) => name.endsWith('.schema.json'))
      .filter((name) => !generated.has(name));
    expect(
      orphans,
      `gilde carries schema files nothing exports any more: ${orphans.join(', ')}. Delete them in gilde, or add the missing entry to GILDE_SCHEMA_EXPORTS.`,
    ).toEqual([]);
  });
});
