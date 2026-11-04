import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { WASM_BASELINE_FLAGS, extractCodeSymbols } from './symbols.js';

const nodeRequire = createRequire(import.meta.url);

/**
 * Parses enough Swift to reach V8's optimizing tier on a stock Node. It runs in
 * a child because the crash is a process fatal that would take the worker with
 * it, and because workers carry wasm flags of their own that would hide it.
 */
const PARSE_SWIFT_UNTIL_HOT = `
const { setFlagsFromString } = require('node:v8');
const { dirname, join } = require('node:path');
for (const flag of JSON.parse(process.env.WASM_FLAGS)) setFlagsFromString(flag);
const runtime = process.env.WEB_TREE_SITTER;
const { Parser, Language } = require(runtime);
const source = Array.from({ length: 60 }, (_, i) => [
  'class Box' + i + ': Codable {',
  '  var value: Int = ' + i,
  '  func doubled(_ x: Int) -> Int { return x * 2 + value }',
  '}',
].join('\\n')).join('\\n');
(async () => {
  await Parser.init({ locateFile: (file) => join(dirname(runtime), file) });
  const parser = new Parser();
  parser.setLanguage(await Language.load(process.env.SWIFT_GRAMMAR));
  for (let i = 0; i < 400; i += 1) {
    parser.parse(source)?.delete();
    await new Promise((resolve) => setImmediate(resolve));
  }
  parser.delete();
  console.log('survived');
})();
`;

describe('extractCodeSymbols (Swift)', () => {
  it('survives the Swift volume that aborts the optimizing wasm tier', async () => {
    const grammars = join(dirname(nodeRequire.resolve('tree-sitter-wasms/package.json')), 'out');
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', PARSE_SWIFT_UNTIL_HOT], {
      env: {
        ...process.env,
        WASM_FLAGS: JSON.stringify(WASM_BASELINE_FLAGS),
        WEB_TREE_SITTER: nodeRequire.resolve('web-tree-sitter'),
        SWIFT_GRAMMAR: join(grammars, 'tree-sitter-swift.wasm'),
      },
    });
    expect(stdout).toContain('survived');
  }, 60_000);

  it('runs in the isolated integration lane', ({ task }) => {
    expect(task.file.projectName).toBe('integration');
  });

  it('extracts protocols, classes, and functions', async () => {
    const code = [
      'protocol Drawable {',
      '  func draw()',
      '}',
      'class Circle {',
      '  func draw() {}',
      '}',
      'func area(radius: Double) -> Double { return 3.14 * radius * radius }',
    ].join('\n');
    const syms = await extractCodeSymbols('swift', code);
    expect(syms).not.toBeNull();
    const kinds = new Map(syms!.map((s) => [s.name, s.kind]));
    expect(kinds.get('Circle')).toBe('class');
    expect(kinds.get('area')).toBe('function');
    expect(kinds.get('Drawable')).toBe('protocol');
  });
});
