import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
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

async function collectSources(): Promise<string[]> {
  // `URL#pathname` on Windows yields `/C:/...` (leading slash), which
  // corrupts `path.join` into `C:\C:\...`. fileURLToPath drops the
  // leading slash and normalizes separators.
  const root = fileURLToPath(new URL('../../../..', import.meta.url));
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
    for (const file of files) {
      const src = await readFile(file, 'utf8');
      for (const re of FORBIDDEN_PATTERNS) {
        if (re.test(src)) {
          offenders.push(`${file}: matches ${re}`);
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
