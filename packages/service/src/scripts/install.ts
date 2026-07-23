import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type CraftbookTemplateManifest, createLogger } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import {
  craftbookShardPrefix,
  craftbookTemplateScriptsDir,
  projectScriptFile,
} from '@bendyline/gezel/paths';

const log = createLogger('scripts');

const PROVENANCE_MARKER = '// @gezel-craftbook:';
const PROJECT_TYPE_MARKER = '// @gezel-project-type:';

/**
 * Write one script file into a project prefixed with a provenance line,
 * idempotently. `provenanceLine` is the full marker line INCLUDING its
 * trailing newline (e.g. `// @gezel-craftbook: id@1.0.0\n`). No-ops when the
 * same provenance + body is already on disk.
 */
async function installOneScript(
  home: string,
  projectId: string,
  provenanceLine: string,
  name: string,
  body: string,
): Promise<boolean> {
  const dest = projectScriptFile(home, projectId, name);
  await mkdir(dirname(dest), { recursive: true });
  const existing = await readFile(dest, 'utf8').catch(() => null);
  const incoming = `${provenanceLine}${body}`;
  if (existing?.startsWith(provenanceLine) && existing.slice(provenanceLine.length) === body) {
    return false; // same version already installed
  }
  await writeFile(dest, incoming, 'utf8');
  return true;
}

/**
 * Install the scripts BUNDLED inside a LOCAL craftbook template (created
 * in the editor — `~/.gezel/craftbook-templates/<shard>/<id>/versions/
 * <ver>/scripts/*.ts`) into a project. The local-source counterpart of
 * {@link installCraftbookScripts}, which reads the bundled catalog. Reads
 * the on-disk scripts dir directly (no `bundledScripts` manifest needed).
 */
export async function installLocalCraftbookScripts(
  home: string,
  projectId: string,
  craftbookId: string,
  version: string,
): Promise<{ installed: string[]; skipped: string[] }> {
  const prefix = craftbookShardPrefix(craftbookId);
  const dir = craftbookTemplateScriptsDir(home, prefix, craftbookId, version);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.ts'));
  } catch {
    return { installed: [], skipped: [] };
  }
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const filename of files) {
    const name = filename.slice(0, -3);
    const body = await readFile(join(dir, filename), 'utf8').catch(() => null);
    if (body == null) {
      skipped.push(name);
      continue;
    }
    if (
      await installOneScript(
        home,
        projectId,
        `${PROVENANCE_MARKER} ${craftbookId}@${version}\n`,
        name,
        body,
      )
    )
      installed.push(name);
    else skipped.push(name);
  }
  if (installed.length > 0) {
    log.info(
      `[install] local craftbook ${craftbookId}@${version}: installed ${installed.length} script(s) into ${projectId}`,
    );
  }
  return { installed, skipped };
}

/**
 * Install a project type's inline SDK scripts (name → TypeScript source) into
 * a project's `scripts/` directory, each prefixed with a
 * `// @gezel-project-type:` provenance marker. Idempotent the same way the
 * craftbook installer is: re-running upgrades when the marker/body differs,
 * no-ops when they match. See docs/project-types.md.
 */
export async function installProjectTypeScripts(
  home: string,
  projectId: string,
  typeId: string,
  version: string,
  scripts: Record<string, string> | undefined,
): Promise<{ installed: string[]; skipped: string[] }> {
  const installed: string[] = [];
  const skipped: string[] = [];
  const provenance = `${PROJECT_TYPE_MARKER} ${typeId}@${version}\n`;
  for (const [name, body] of Object.entries(scripts ?? {})) {
    if (await installOneScript(home, projectId, provenance, name, body)) installed.push(name);
    else skipped.push(name);
  }
  if (installed.length > 0) {
    log.info(
      `[install] project type ${typeId}@${version}: installed ${installed.length} script(s) into ${projectId}`,
    );
  }
  return { installed, skipped };
}

/**
 * Provenance (`<typeId>@<version>`) of a script installed by a project type,
 * or null when the content doesn't carry the project-type marker. Mirrors
 * {@link craftbookScriptProvenance}.
 */
export function projectTypeScriptProvenance(content: string): string | null {
  if (!content.startsWith(PROJECT_TYPE_MARKER)) return null;
  const newlineIdx = content.indexOf('\n');
  const line = newlineIdx === -1 ? content : content.slice(0, newlineIdx);
  return line.slice(PROJECT_TYPE_MARKER.length).trim();
}

/**
 * Read a bundled craftbook's `bundledScripts` files out of the catalog
 * into the runtime `scripts` map (name → source) — the hydration that
 * makes a bundled book carry its sources inline, so task snapshots
 * execute gates from their own copy. Returns undefined when the book
 * bundles no scripts.
 */
export async function readBundledCraftbookScripts(
  catalog: CatalogService,
  craftbook: CraftbookTemplateManifest,
): Promise<Record<string, string> | undefined> {
  // Single-document craftbooks (V2) already carry their sources inline on
  // the resolved manifest — no catalog file reads needed. The file-read
  // path below stays for legacy layouts (bundledScripts without a map).
  if (craftbook.scripts && Object.keys(craftbook.scripts).length > 0) {
    return craftbook.scripts;
  }
  const files = (craftbook.bundledScripts ?? []).filter((f) => f.endsWith('.ts'));
  if (files.length === 0) return undefined;
  const scripts: Record<string, string> = {};
  for (const filename of files) {
    const buf = await catalog
      .readItemFile(
        'craftbook-template',
        craftbook.id,
        `scripts/${filename}`,
        undefined,
        craftbook.version,
      )
      .catch(() => null);
    if (!buf) {
      log.warn(
        `[hydrate] craftbook ${craftbook.id}@${craftbook.version}: script file not found: ${filename}`,
      );
      continue;
    }
    scripts[filename.slice(0, -3)] = buf.toString('utf8');
  }
  return Object.keys(scripts).length > 0 ? scripts : undefined;
}

/**
 * Copy a craftbook template's bundled scripts into a project's
 * `scripts/` directory. The manifest's `bundledScripts: string[]`
 * lists filenames inside the version's `scripts/` subfolder; each
 * file is read from the catalog source, prefixed with a provenance
 * marker comment, and written verbatim.
 *
 * Idempotent: re-running upgrades to the latest version when the
 * marker differs, no-ops when it matches. The marker is the only
 * mechanism the uninstall path uses to detect "this script came from
 * craftbook X" — manual edits past the marker line are preserved
 * during read but lost on reinstall (the source is the catalog).
 */
export async function installCraftbookScripts(
  home: string,
  projectId: string,
  craftbook: CraftbookTemplateManifest,
  catalog: CatalogService,
): Promise<{ installed: string[]; skipped: string[] }> {
  const scripts = craftbook.bundledScripts ?? [];
  if (scripts.length === 0) return { installed: [], skipped: [] };
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const filename of scripts) {
    if (!filename.endsWith('.ts')) {
      log.warn(`[install] craftbook ${craftbook.id}: skipping non-.ts script ${filename}`);
      skipped.push(filename);
      continue;
    }
    const buf = await catalog.readItemFile(
      'craftbook-template',
      craftbook.id,
      `scripts/${filename}`,
      undefined,
      craftbook.version,
    );
    if (!buf) {
      log.warn(
        `[install] craftbook ${craftbook.id}@${craftbook.version}: script file not found: ${filename}`,
      );
      skipped.push(filename);
      continue;
    }
    const name = filename.slice(0, -3);
    const dest = projectScriptFile(home, projectId, name);
    await mkdir(dirname(dest), { recursive: true });
    const provenance = `${PROVENANCE_MARKER} ${craftbook.id}@${craftbook.version}\n`;
    const existing = await readFile(dest, 'utf8').catch(() => null);
    const incoming = `${provenance}${buf.toString('utf8')}`;
    if (existing?.startsWith(provenance)) {
      // Same version already installed — no-op.
      const sansMarkerExisting = existing.slice(provenance.length);
      const sansMarkerIncoming = incoming.slice(provenance.length);
      if (sansMarkerExisting === sansMarkerIncoming) {
        skipped.push(name);
        continue;
      }
    }
    await writeFile(dest, incoming, 'utf8');
    installed.push(name);
  }
  if (installed.length > 0) {
    log.info(
      `[install] craftbook ${craftbook.id}@${craftbook.version}: installed ${installed.length} script(s) into ${projectId}`,
    );
  }
  return { installed, skipped };
}

/**
 * True iff the given on-disk script came from a craftbook (the first
 * line matches the provenance marker). Used by the uninstall path
 * and by audit views to flag "this script is managed by craftbook X."
 */
export function craftbookScriptProvenance(content: string): string | null {
  if (!content.startsWith(PROVENANCE_MARKER)) return null;
  const newlineIdx = content.indexOf('\n');
  const line = newlineIdx === -1 ? content : content.slice(0, newlineIdx);
  return line.slice(PROVENANCE_MARKER.length).trim();
}

/** Helper exported for tests so they can construct expected file content. */
export function craftbookScriptHeader(craftbookId: string, version: string): string {
  return `${PROVENANCE_MARKER} ${craftbookId}@${version}\n`;
}

const IMPORT_MARKER = '// @gezel-import:';

/**
 * Write a script that was *generated* (not copied from the catalog) —
 * e.g. a bash scriptlet translated from an imported SKILL.md. Marked with
 * a distinct `// @gezel-import:` provenance line carrying the source +
 * content hash so the import-sync engine can tell "this came from skill X
 * at hash H" apart from catalog-bundled and hand-authored scripts, and
 * detect when the user has manually edited it. Returns the written path.
 */
export async function writeGeneratedScript(
  home: string,
  projectId: string,
  name: string,
  body: string,
  provenance: string,
): Promise<string> {
  const dest = projectScriptFile(home, projectId, name);
  await mkdir(dirname(dest), { recursive: true });
  const header = `${IMPORT_MARKER} ${provenance}\n`;
  await writeFile(dest, `${header}${body}`, 'utf8');
  return dest;
}

/** Provenance string (`<source>#<hash>`) of a generated import script, or null. */
export function generatedScriptProvenance(content: string): string | null {
  if (!content.startsWith(IMPORT_MARKER)) return null;
  const newlineIdx = content.indexOf('\n');
  const line = newlineIdx === -1 ? content : content.slice(0, newlineIdx);
  return line.slice(IMPORT_MARKER.length).trim();
}
