import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gildePackageRoot } from './gilde-data.js';
import { renderGildeSchemaFiles } from './gilde-schema-export.js';

/**
 * Reports — never fails on — how gilde's committed JSON Schema snapshots
 * compare with core's Zod schemas.
 *
 * gilde ships on its own schedule, so the two are routinely a little apart
 * in either direction, and neither direction breaks this build: the catalog
 * loader lists from gilde's `raw-index.json` — the item files verbatim — and
 * reads every manifest and craftbook through core's own schemas, tolerantly
 * (`parseTolerant`). What a stale snapshot costs is authoring: gilde's
 * validator checks content against it, so a book cannot cleanly use a newer
 * field until gilde regenerates its schemas, and the legacy `index.json` that
 * older builds read strips it. That is gilde's to fix, in the gilde change
 * that first uses the field, so here it is a warning.
 *
 * This file used to fail on any drift, which chained every core schema
 * change to a gilde release and a pin bump before gezel CI could go green.
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
      `  ${missing.length} property path(s) in core but not in gilde's copy — gilde content cannot use these yet: ${cap(missing)}`,
    );
  }
  if (orphaned.length > 0) {
    lines.push(`  ${orphaned.length} in gilde's copy but not generated here: ${cap(orphaned)}`);
  }
  if (changed.length > 0) lines.push(`  ${changed.length} changed: ${cap(changed)}`);
  return lines.join('\n');
}

/** Every way the resolved gilde's schemas/ differs from what core generates. */
function schemaDrift(schemasDir: string): string[] {
  if (!existsSync(schemasDir)) {
    return [
      `No schemas/ in the resolved gilde (${schemasDir}); gilde CI is validating against nothing.`,
    ];
  }
  const drift: string[] = [];
  const generated = renderGildeSchemaFiles();
  for (const [filename, content] of generated) {
    const path = join(schemasDir, filename);
    if (!existsSync(path)) {
      drift.push(`${filename}: missing from gilde's schemas/.`);
      continue;
    }
    const committed = readFileSync(path, 'utf8');
    if (committed === content) continue;
    drift.push(
      filename.endsWith('.json')
        ? describeDrift(filename, content, committed)
        : `${filename}: differs from the generated copy.`,
    );
  }
  const names = new Set(generated.map(([filename]) => filename));
  const orphans = readdirSync(schemasDir).filter(
    (name) => name.endsWith('.schema.json') && !names.has(name),
  );
  if (orphans.length > 0) {
    drift.push(`gilde carries schema files this build does not export: ${orphans.join(', ')}.`);
  }
  return drift;
}

/**
 * Warn in the test output and, on GitHub Actions, in the job summary — the
 * one place a warning survives `pnpm -r` prefixing every output line.
 * Written to stderr directly: vitest swallows a passing test's `console`.
 */
function report(root: string, drift: string[]): void {
  const heading = `gilde's schemas differ from core (${drift.length} finding(s), non-blocking)`;
  process.stderr.write(
    `\n${heading} — resolved gilde: ${root}\n\n${drift.join('\n')}\n\n${FIX}\n\n`,
  );
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  const files = drift.map((entry) => `- ${entry.split('\n')[0]?.replace(/:$/, '')}`).join('\n');
  try {
    appendFileSync(summary, `### ${heading}\n\n${files}\n\n${FIX}\n\n`);
  } catch {
    // A summary that cannot be written is not worth failing a report over.
  }
}

describe('gilde schemas compared with core', () => {
  it('reports drift without failing', () => {
    const root = process.env.GILDE_DIR?.trim()
      ? resolve(process.env.GILDE_DIR.trim())
      : gildePackageRoot();
    const drift = schemaDrift(join(root, 'schemas'));
    if (drift.length > 0) report(root, drift);
  });

  it('names the property paths that drifted', () => {
    const generated = JSON.stringify({ properties: { a: { type: 'string' }, b: { const: 'x' } } });
    const committed = JSON.stringify({ properties: { b: { const: 'y' }, c: { type: 'number' } } });
    expect(describeDrift('x.schema.json', generated, committed)).toBe(
      [
        'x.schema.json:',
        "  1 property path(s) in core but not in gilde's copy — gilde content cannot use these yet: .properties.a.type",
        "  1 in gilde's copy but not generated here: .properties.c.type",
        '  1 changed: .properties.b.const',
      ].join('\n'),
    );
  });
});
