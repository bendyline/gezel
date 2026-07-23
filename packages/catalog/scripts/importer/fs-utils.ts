import { execFile } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** Make sure the directory holding `filePath` exists. */
export async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

/**
 * Write JSON atomically — temp file + rename so a half-written
 * manifest never lands in the catalog. Pretty-prints with a trailing
 * newline, matching the existing catalog's formatting convention.
 *
 * The raw `JSON.stringify(..., 2)` output expands every array
 * vertically, but biome's formatter wants short arrays inline (e.g.
 * `"envHints": ["FOO", "BAR"]`). Mismatching produces thousands of
 * `pnpm lint` errors after a community import. The fix-up step in
 * `formatPathsViaBiome` re-runs biome format over the affected paths
 * so the persisted shape matches the lint baseline.
 */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await ensureDir(filePath);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, filePath);
}

/**
 * Run `biome format --write` over the given paths so the persisted
 * shape matches what `pnpm lint` expects. Per-file shelling out is
 * too expensive for a 5000-entry import (~50ms × 5000 = 4 minutes of
 * spawn overhead), so callers should batch — pass a directory or a
 * list of paths, biome processes the whole batch in one process.
 *
 * Tolerant of failure: a non-zero exit (e.g. biome dependency not
 * installed in a one-off environment) logs a warning and returns. We
 * never want a formatting hiccup to abort an otherwise-successful
 * import.
 */
export async function formatPathsViaBiome(
  paths: string[],
  opts: { cwd?: string } = {},
): Promise<void> {
  if (paths.length === 0) return;
  try {
    await execFileP('pnpm', ['exec', 'biome', 'format', '--write', ...paths], {
      cwd: opts.cwd,
      // 5000 community manifests format in well under a second; cap
      // generously so a stuck process surfaces as a real error rather
      // than hanging the import.
      timeout: 60_000,
      // Biome can produce a lot of stdout when many files change; raise
      // the buffer so it doesn't truncate.
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    console.warn(
      `[importer] biome format step failed for ${paths.length} path(s); manifests are written but may need a manual \`pnpm lint --write\` pass. Error: ${(err as Error).message}`,
    );
  }
}
