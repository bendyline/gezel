import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guard against accidentally promoting a secret into the main process's
 * `process.env` — where a crash report, child process, or third-party
 * library could capture it. Secrets are only meant to enter the env of
 * MCP subprocesses we spawn, via `StdioClientTransport`'s `env` option.
 *
 * If this test starts failing with a legitimate reason, think hard before
 * adding an exception.
 */

const FORBIDDEN_PATTERNS = [/\bprocess\.env\s*=\s/, /\bObject\.assign\(\s*process\.env\b/];

/** Repo-relative path → why its bulk env write cannot promote a secret. */
const ALLOWED: Record<string, string> = {
  // The supervisor forks this utility process early to prewarm the service
  // import, then sends the environment it finished preparing. Every value is
  // the supervisor's own `process.env` — the env the in-process service runs
  // under — so this replays the parent's env, never a secret from elsewhere.
  'packages/app/src/supervisor/utility-service-entry.ts':
    'mirrors the supervisor process.env into its prewarmed service child',
};

function countMatches(src: string, re: RegExp): number {
  return src.match(new RegExp(re.source, 'g'))?.length ?? 0;
}

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.turbo') continue;
      await walk(p, out);
    } else if (e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.tsx'))) {
      if (e.name.endsWith('.test.ts') || e.name.endsWith('.test.tsx')) continue;
      out.push(p);
    }
  }
}

// `URL#pathname` on Windows yields `/C:/...` (leading slash), which
// corrupts `path.join` into `C:\C:\...`. fileURLToPath drops the
// leading slash and normalizes separators.
const root = fileURLToPath(new URL('../../../..', import.meta.url));

async function collectSources(): Promise<string[]> {
  const packages = await readdir(join(root, 'packages'));
  const out: string[] = [];
  for (const pkg of packages) {
    const srcDir = join(root, 'packages', pkg, 'src');
    try {
      await walk(srcDir, out);
    } catch {
      // package has no src/, skip
    }
  }
  return out;
}

describe('process.env mutation guard', () => {
  it('no source file mutates process.env', async () => {
    const files = await collectSources();
    expect(files.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    const excused = new Set<string>();
    for (const file of files) {
      const src = await readFile(file, 'utf8');
      const matches = FORBIDDEN_PATTERNS.filter((re) => re.test(src));
      if (matches.length === 0) continue;
      const rel = relative(root, file).split(sep).join('/');
      // One bulk write is excused, not the file: a second is a new decision.
      if (rel in ALLOWED && matches.length === 1 && countMatches(src, matches[0]!) === 1) {
        excused.add(rel);
      } else {
        offenders.push(`${file}: matches ${matches.join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
    // An exception whose write is gone must leave the list with it.
    expect(Object.keys(ALLOWED).filter((rel) => !excused.has(rel))).toEqual([]);
  }, 15_000);
});
