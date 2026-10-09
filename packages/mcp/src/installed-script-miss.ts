/**
 * What to tell a model whose `run_installed_script` call cannot work: the
 * name is a file path, or it matched no installed script.
 *
 * Small models write `scripts/clean_data.mjs` and then call
 * `run_installed_script({ name: "clean_data" })`, which runs only scripts
 * installed in the project. The bare "not found. Available scripts: (none)"
 * read to them as a transient failure: gemma4-e4b repeated it 43-205 times per
 * data-wrangle trial and every such trial failed, while the one pass never
 * called it (2026-10-06).
 *
 * The session-wide roster is all this process knows. A harness repair turn
 * narrows the surface to file tools and keeps `run_installed_script` but not
 * `run_nodejs_script`, so "use run_nodejs_script instead" named a tool the
 * turn did not have (2026-10-07). Every file-repair surface keeps
 * `write_file`, so the hint always ends on that.
 */

const SCRIPT_DIRS = ['', 'scripts/', 'src/', 'bin/', 'tools/'];
const SCRIPT_EXTS = ['.mjs', '.js', '.ts', '.cjs'];

/** Workspace paths a bare script name most likely refers to, most likely first. */
export function scriptFileCandidates(name: string): string[] {
  const bare = name.trim();
  if (!/^[\w.-]+$/.test(bare)) return [];
  const stem = bare.replace(/\.(?:mjs|cjs|js|ts)$/i, '');
  return SCRIPT_DIRS.flatMap((dir) => SCRIPT_EXTS.map((ext) => `${dir}${stem}${ext}`));
}

/** True when `name` is a file path rather than an installed script's name. */
export function isPathShapedScriptName(name: string): boolean {
  return /[/\\]/.test(name) || /\.(mjs|cjs|js|ts|py|sh)$/i.test(name);
}

export function installedScriptMissHint(opts: {
  name: string;
  /** A workspace file the name matches, when one exists. */
  written?: string;
  /** Whether this session can call `run_nodejs_script`. */
  canRunFiles: boolean;
  /** Whether this session can call `derive_file`. */
  canDerive: boolean;
  /** Whether this session can call `write_file`. */
  canWriteFiles?: boolean;
}): string {
  const { name, written, canRunFiles, canDerive, canWriteFiles = false } = opts;
  const file = written ?? (isPathShapedScriptName(name) ? name : undefined);
  const lead = isPathShapedScriptName(name)
    ? `"${name}" looks like a file path, but run_installed_script runs only scripts installed in the project (see list_scripts).`
    : written
      ? `"${name}" is not an installed script, but the project has \`${written}\`, a file you wrote.`
      : `run_installed_script only runs scripts installed in the project (see list_scripts), and "${name}" is not one.`;
  const steps: string[] = [];
  if (canRunFiles) {
    steps.push(
      file
        ? `Run that file with run_nodejs_script({ path: "${file}" }).`
        : 'To run a script file you wrote, use run_nodejs_script({ path }).',
    );
  }
  if (canDerive && !file) steps.push('To build a data file from other files, use derive_file.');
  if (canWriteFiles) {
    steps.push(
      canRunFiles
        ? 'If run_nodejs_script is not in your tool list this turn, write the output file directly with write_file.'
        : 'Write the output file directly with write_file instead.',
    );
  }
  const again = 'Calling run_installed_script again with this name will fail the same way.';
  return [lead, ...steps, again].join(' ');
}
