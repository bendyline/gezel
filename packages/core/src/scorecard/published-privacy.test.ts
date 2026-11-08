import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const scorecardDir = join(repoRoot, 'docs/handboek/assets/scorecards');

function publishedFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return publishedFiles(path);
    return /\.(json|csv|md)$/.test(entry.name) ? [path] : [];
  });
}

// gezel.com publishes this tree as-is. The 2026-10-28 R9700 round shipped a
// workstation's hostname on 264 lines for two releases before anyone noticed.
describe('published scorecard files', () => {
  const files = publishedFiles(scorecardDir);

  it('record every hostname as <host>', () => {
    const leaks = files.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/"hostname"\s*:\s*"([^"]*)"/g)]
        .filter((match) => match[1] !== '<host>')
        .map((match) => `${relative(repoRoot, file)}: ${match[1]}`),
    );
    expect([...new Set(leaks)]).toEqual([]);
  });

  it('carry no home folder paths', () => {
    const homePath = /\/Users\/[A-Za-z]|\/home\/[a-z]|[A-Za-z]:\\\\Users\\\\/;
    const leaks = files
      .filter((file) => homePath.test(readFileSync(file, 'utf8')))
      .map((file) => relative(repoRoot, file));
    expect(leaks).toEqual([]);
  });
});
