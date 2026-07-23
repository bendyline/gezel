import { describe, expect, it } from 'vitest';
import { transpileShellBlock } from './transpile-shell.js';

/**
 * Mirror of the service-side `validateScriptBody` rules — static output
 * must satisfy the same contract the LLM translator is validated
 * against (one gate, two producers).
 */
function passesTranslatorContract(body: string): boolean {
  if (!/from\s+['"]@bendyline\/gezel-sdk['"]/.test(body)) return false;
  if (!/export\s+const\s+meta\s*=\s*defineScript\(/.test(body)) return false;
  if (!/gezel\.output\(/.test(body)) return false;
  for (const m of body.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
    if (m[1] !== '@bendyline/gezel-sdk') return false;
  }
  if (/\b(require|eval|child_process)\b|node:|process\.env\s*\[/.test(body)) return false;
  return true;
}

describe('transpileShellBlock', () => {
  it('converts package-script and read-only fs lines', () => {
    const result = transpileShellBlock(
      [
        '# run the checks',
        'npm run lint',
        'pnpm test',
        'cat README.md',
        'ls src',
        'echo done',
      ].join('\n'),
      'demo-s1',
    );
    expect(result).not.toBeNull();
    const body = result!.body;
    expect(body).toContain('gezel.mcp.call(\'run_package_script\', { script: "lint" })');
    expect(body).toContain('{ script: "test" }');
    expect(body).toContain('gezel.fs.read("README.md")');
    expect(body).toContain('gezel.fs.list("src")');
    expect(body).toContain('gezel.log("done")');
    expect(body).toContain("requires: ['workspace.read']");
    expect(passesTranslatorContract(body)).toBe(true);
  });

  it('omits workspace.read when no fs line is present', () => {
    const result = transpileShellBlock('npm run build', 'demo-s2');
    expect(result!.body).toContain('requires: []');
    expect(passesTranslatorContract(result!.body)).toBe(true);
  });

  it('is deterministic', () => {
    const a = transpileShellBlock('npm test\ncat a.md', 'x-s1');
    const b = transpileShellBlock('npm test\ncat a.md', 'x-s1');
    expect(a!.body).toBe(b!.body);
  });

  it('rejects blocks with any unmappable line', () => {
    expect(transpileShellBlock('npm run lint -- --fix', 's')).toBeNull();
    expect(transpileShellBlock('git status', 's')).toBeNull();
    expect(transpileShellBlock('npx create-thing', 's')).toBeNull();
    expect(transpileShellBlock('node scripts/x.mjs', 's')).toBeNull();
    expect(transpileShellBlock('rm -rf dist', 's')).toBeNull();
    expect(transpileShellBlock('npm test && npm run build', 's')).toBeNull();
    expect(transpileShellBlock('cat ../outside.md', 's')).toBeNull();
    expect(transpileShellBlock('cat /etc/passwd', 's')).toBeNull();
  });

  it('rejects blocks with no effectful line', () => {
    expect(transpileShellBlock('# just a comment\npwd', 's')).toBeNull();
    expect(transpileShellBlock('', 's')).toBeNull();
  });
});
