import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const scripts = (await readdir(scriptsDir))
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .sort();

describe('standard gate script contracts', () => {
  it('keeps the expected standard library breadth', () => {
    expect(scripts).toHaveLength(33);
  });

  it.each(scripts)('%s has loadable, discoverable metadata', async (filename) => {
    const source = await readFile(join(scriptsDir, filename), 'utf8');
    const expectedName = basename(filename, '.ts');

    expect(source).toContain('export const meta = defineScript({');
    expect(source).toMatch(new RegExp(`name:\\s*['"]${expectedName}['"]`));
    expect(source).toMatch(/kind:\s*['"]gate['"]/);
    expect(source).toMatch(/description:\s*/);
    expect(source).toMatch(/inputs:\s*{/);
    expect(source).toMatch(/outputs:\s*{/);
    expect(source).toMatch(/decision:\s*{/);
    expect(source).toMatch(/message:\s*{/);
    expect(source).toMatch(/requires:\s*\[[^\]]+\]/s);
    expect(source).toContain('gezel.output(');
  });

  it.each(scripts)('%s stays inside the SDK capability boundary', async (filename) => {
    const source = await readFile(join(scriptsDir, filename), 'utf8');

    expect(source).not.toMatch(/from\s+['"]node:/);
    expect(source).not.toMatch(/\bprocess\s*\./);
    expect(source).not.toMatch(/\b(?:eval|Function)\s*\(/);
    expect(source).not.toMatch(/\b(?:fetch|XMLHttpRequest)\s*\(/);
  });
});
