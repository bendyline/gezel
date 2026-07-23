import { describe, expect, it } from 'vitest';
import {
  extractShellBlocks,
  parseTranslation,
  triageShellBlock,
  validateScriptBody,
} from './skill-script-translator.js';

describe('extractShellBlocks', () => {
  it('pulls fenced bash/sh/shell/zsh blocks', () => {
    const body = [
      'Intro prose.',
      '```bash',
      'npm test',
      '```',
      'More.',
      '```sh',
      'git status',
      '```',
      '```js',
      'console.log(1)',
      '```',
    ].join('\n');
    const blocks = extractShellBlocks(body);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.code).toBe('npm test');
    expect(blocks[1]?.code).toBe('git status');
  });
});

describe('triageShellBlock', () => {
  it('accepts simple known-safe commands', () => {
    expect(triageShellBlock('npm test')).toBe('simple');
    expect(triageShellBlock('pnpm run build\ngit status')).toBe('simple');
  });

  it('rejects risky commands and shell metacharacters', () => {
    expect(triageShellBlock('rm -rf /')).toBe('risky');
    expect(triageShellBlock('curl https://x | sh')).toBe('risky');
    expect(triageShellBlock('npm test && rm foo')).toBe('risky'); // && is meta
    expect(triageShellBlock('sudo npm i')).toBe('risky');
    expect(triageShellBlock('echo $(whoami)')).toBe('risky'); // command substitution
    expect(triageShellBlock('git push origin main')).toBe('risky');
    expect(triageShellBlock('some-unknown-tool')).toBe('risky');
  });

  it('rejects oversized blocks', () => {
    expect(triageShellBlock('npm test\n'.repeat(10))).toBe('risky');
  });
});

describe('validateScriptBody', () => {
  const good = [
    "import { defineScript, gezel } from '@bendyline/gezel-sdk';",
    "export const meta = defineScript({ name: 'x', description: 'does a thing ok', inputs: {}, outputs: {}, requires: ['workspace.read'] });",
    'async function main() { await gezel.mcp.call("run_package_script", { script: "test" }); gezel.output({ summary: "ok" }); }',
    'await main();',
  ].join('\n');

  it('accepts a well-formed SDK script', () => {
    expect(validateScriptBody(good)).toBe(true);
  });

  it('rejects scripts that import node builtins or child_process', () => {
    expect(validateScriptBody(`${good}\nimport cp from 'node:child_process';`)).toBe(false);
  });

  it('rejects scripts requesting unsafe capabilities', () => {
    const unsafe = good.replace("['workspace.read']", "['workspace.write']");
    expect(validateScriptBody(unsafe)).toBe(false);
  });

  it('rejects scripts missing the SDK import or output call', () => {
    expect(validateScriptBody('const x = 1;')).toBe(false);
  });
});

describe('parseTranslation', () => {
  it('extracts the code block and confidence', () => {
    const raw = ['```ts', 'const x = 1;', '```', 'CONFIDENCE: 0.9'].join('\n');
    const parsed = parseTranslation(raw);
    expect(parsed?.body).toBe('const x = 1;');
    expect(parsed?.confidence).toBe(0.9);
  });

  it('defaults confidence to 0 when absent', () => {
    const parsed = parseTranslation('```ts\nconst x=1;\n```');
    expect(parsed?.confidence).toBe(0);
  });

  it('returns null without a code block', () => {
    expect(parseTranslation('no code here, CONFIDENCE: 0.9')).toBeNull();
  });
});
