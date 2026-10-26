/**
 * What a write does to a package manifest's `scripts`, for the
 * `allowPackageScriptEdits` capability. A script a gezel plants runs later
 * with the person's whole account — in `run_package_script`, or in their own
 * terminal's `npm test` — so adding or changing one is its own permission.
 *
 * Removing a script is not gated: it cannot make anything run that the
 * person did not write. A JSON manifest is compared by its parsed `scripts`,
 * so edits to versions, dependencies, or formatting pass. The other manifest
 * formats pnpm reads are not parsed here, and any change to them counts.
 */

const MANIFEST_BASENAMES = new Set(['package.json', 'package.json5', 'package.yaml']);

/**
 * True for a path pnpm or npm reads scripts from. Case-insensitive, because
 * `PACKAGE.JSON` is the same file on Windows and macOS.
 */
export function isPackageManifestPath(path: string): boolean {
  const base = path.split(/[\\/]/).pop() ?? '';
  return MANIFEST_BASENAMES.has(base.toLowerCase());
}

export type PackageScriptsEdit =
  | { kind: 'unchanged' }
  /** `names` is empty for a manifest format this module does not parse. */
  | { kind: 'changed'; names: string[] }
  /** The write would leave a manifest that had scripts unparseable. */
  | { kind: 'unreadable' };

/**
 * Compare a manifest before and after a write. `null` means the file does
 * not exist on that side. Not a manifest path → `unchanged`.
 */
export function packageScriptsEdit(
  path: string,
  before: string | null,
  after: string | null,
): PackageScriptsEdit {
  if (!isPackageManifestPath(path) || after === null) return { kind: 'unchanged' };
  if (!path.toLowerCase().endsWith('package.json')) {
    return before === after ? { kind: 'unchanged' } : { kind: 'changed', names: [] };
  }
  // A manifest someone else already broke has no scripts we can trust, so
  // everything the write puts there counts as new. Gezels cannot reach that
  // state themselves: breaking a manifest that had scripts is refused below.
  const was = before === null ? {} : (parseScripts(before) ?? {});
  const now = parseScripts(after);
  if (now === null)
    return Object.keys(was).length > 0 ? { kind: 'unreadable' } : { kind: 'unchanged' };
  const names = Object.keys(now).filter(
    (name) => !Object.hasOwn(was, name) || was[name] !== now[name],
  );
  return names.length > 0 ? { kind: 'changed', names } : { kind: 'unchanged' };
}

/** The model-facing refusal for a gated edit. */
export function packageScriptsEditRefusal(path: string, edit: PackageScriptsEdit): string {
  const setting =
    'Gezels may not add or change package scripts here ("Edit package scripts" is off in Settings → Security & Compliance).';
  if (edit.kind === 'unreadable') {
    return `${setting} This write would leave ${path} unreadable, which removes its scripts. Keep ${path} valid JSON with its "scripts" unchanged.`;
  }
  const which =
    edit.kind === 'changed' && edit.names.length > 0
      ? ` It would add or change ${edit.names.map((name) => `"${name}"`).join(', ')}.`
      : '';
  return `${setting}${which} Leave the scripts in ${path} as they are; other fields may still change. If the work needs a new or changed script, tell the person what it should be.`;
}

/** Each script name mapped to its canonical body; `null` when the text is not a JSON object. */
function parseScripts(text: string): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return {};
  const out: Record<string, string> = {};
  for (const [name, body] of Object.entries(scripts as Record<string, unknown>)) {
    out[name] = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return out;
}
