import { describe, expect, it } from 'vitest';
import { validateSourceContent } from './source-validation.js';

describe('validateSourceContent', () => {
  describe('unrelated extensions', () => {
    it('returns null for .md / .json / .css / no-extension', () => {
      expect(validateSourceContent('notes.md', '# Hello\n')).toBeNull();
      expect(validateSourceContent('data.json', '{"a":1}')).toBeNull();
      expect(validateSourceContent('styles.css', 'body { color: red }')).toBeNull();
      expect(validateSourceContent('LICENSE', 'MIT')).toBeNull();
    });

    it('returns null for empty content of unknown extension', () => {
      expect(validateSourceContent('whatever.bin', '')).toBeNull();
    });
  });

  describe('HTML', () => {
    it('passes a complete, valid HTML page with inline JS', () => {
      const html = `<!DOCTYPE html>
<html><body><button id="b">Hi</button>
<script>
  const b = document.getElementById('b');
  b.addEventListener('click', () => { console.log('clicked'); });
</script></body></html>`;
      const res = validateSourceContent('index.html', html);
      expect(res?.ok).toBe(true);
    });

    it('passes HTML with no <script> tags at all', () => {
      const res = validateSourceContent('about.html', '<html><body>Hi</body></html>');
      expect(res?.ok).toBe(true);
    });

    it('passes HTML with empty <script></script>', () => {
      const res = validateSourceContent('page.html', '<html><body><script></script></body></html>');
      expect(res?.ok).toBe(true);
    });

    it('passes HTML with type=application/ld+json (skipped, not JS)', () => {
      const res = validateSourceContent(
        'page.html',
        '<html><head><script type="application/ld+json">{ this is not js }</script></head></html>',
      );
      expect(res?.ok).toBe(true);
    });

    it('passes HTML with <script src="..."> (no inline body)', () => {
      const res = validateSourceContent(
        'page.html',
        '<html><body><script src="/app.js"></script></body></html>',
      );
      expect(res?.ok).toBe(true);
    });

    it('passes HTML with type="module" (skipped because new Function rejects top-level import)', () => {
      const res = validateSourceContent(
        'page.html',
        '<html><body><script type="module">import {x} from "./y.js"; console.log(x);</script></body></html>',
      );
      expect(res?.ok).toBe(true);
    });

    it('FAILS on the tictactoe failure: missing closing brace on function (Unexpected token for)', () => {
      // Mirrors the gemma4-e4b tictactoe trial that
      // produced 4.3 KB of HTML with a single truncation bug. The
      // signature in the trial log was "Unexpected token 'for'".
      const html = `<html><body><script>
function reset() {
  board = [null, null, null, null, null, null, null, null, null];
  // missing closing brace here
for (let i = 0; i < 9; i++) {
  cells[i].textContent = '';
}
</script></body></html>`;
      const res = validateSourceContent('index.html', html);
      expect(res?.ok).toBe(false);
      if (res && !res.ok) {
        expect(res.message).toMatch(/index\.html/);
        expect(res.message).toMatch(/inline <script> #1/);
      }
    });

    it('FAILS on truncated <script> with no closing tag', () => {
      const html = `<html><body><script>
function play() {
  const cells = document.querySelectorAll('.cell');
  cells.forEach(c => c.addEventListener('click', handleClick));`;
      const res = validateSourceContent('index.html', html);
      expect(res?.ok).toBe(false);
      if (res && !res.ok) {
        expect(res.message).toMatch(/unterminated|truncated|<\/script>/i);
      }
    });

    it('FAILS on a syntax error mid-script with full close tag present', () => {
      const html = '<html><body><script>const x = ; // bad assignment</script></body></html>';
      const res = validateSourceContent('index.html', html);
      expect(res?.ok).toBe(false);
    });

    it('reports the absolute line/col of an inline-script parse error', () => {
      // The tankcombat failure mode: a multi-line inline script with one
      // stray paren. The model needs the line to fix it surgically rather
      // than eyeball the whole block. The bad `)` is on line 4 of the file.
      const html = `<html><body><script>
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
function draw() { ctx.clearRect(0, 0, 10, 10)); }
draw();
</script></body></html>`;
      const res = validateSourceContent('index.html', html);
      expect(res?.ok).toBe(false);
      if (res && !res.ok) {
        expect(res.message).toMatch(/inline <script> #1/);
        expect(res.message).toMatch(/at line 4, col \d+/);
      }
    });

    it('reports the first failing script when multiple are present', () => {
      const html = `<html><body>
<script>const a = 1;</script>
<script>const b = ; // bad</script>
<script>const c = 3;</script>
</body></html>`;
      const res = validateSourceContent('page.html', html);
      expect(res?.ok).toBe(false);
      if (res && !res.ok) expect(res.message).toMatch(/#2/);
    });

    it('handles .htm extension the same as .html', () => {
      const html = '<html><body><script>const x = ;</script></body></html>';
      const res = validateSourceContent('legacy.htm', html);
      expect(res?.ok).toBe(false);
    });
  });

  describe('JS', () => {
    it('passes a clean .js file', () => {
      const res = validateSourceContent('counter.js', 'const x = 1;\nfunction f() { return x; }\n');
      expect(res?.ok).toBe(true);
    });

    it('passes ESM .mjs with imports/exports', () => {
      const res = validateSourceContent(
        'mod.mjs',
        'import { foo } from "./other.js";\nexport const x = foo + 1;\n',
      );
      expect(res?.ok).toBe(true);
    });

    it('FAILS on static imports nested inside functions', () => {
      const res = validateSourceContent(
        'src/render.js',
        "export function render() {\n  import { tasks } from './state.js';\n}\n",
      );
      expect(res?.ok).toBe(false);
      if (res && !res.ok) {
        expect(res.message).toContain('static import/export declarations are only valid');
        expect(res.message).toContain('line 2');
      }
    });

    it('passes CJS .cjs with require', () => {
      const res = validateSourceContent(
        'mod.cjs',
        'const fs = require("fs");\nmodule.exports = { fs };\n',
      );
      expect(res?.ok).toBe(true);
    });

    it('FAILS on unterminated brace', () => {
      const res = validateSourceContent(
        'broken.js',
        'function go() {\n  if (x) {\n    doThing();\n  // missing one close brace\n}\n',
      );
      expect(res?.ok).toBe(false);
    });

    it('FAILS on unterminated string', () => {
      const res = validateSourceContent('broken.js', 'const s = "hello;\n');
      expect(res?.ok).toBe(false);
    });

    it('FAILS on dangling operator', () => {
      const res = validateSourceContent('broken.js', 'const x = ;\n');
      expect(res?.ok).toBe(false);
      if (res && !res.ok) {
        expect(res.message).toMatch(/syntax error at line/);
        expect(res.message).toContain('THE FILE WAS NOT WRITTEN');
        expect(res.message).toContain('no bytes from this call were persisted');
        expect(res.message).toContain('call `writeFile` again');
        expect(res.message).toContain('Do not use `appendToFile`');
      }
    });

    it('FAILS on TypeScript non-null assertions in .mjs files', () => {
      const res = validateSourceContent(
        'server.mjs',
        'import { createServer } from "node:http";\nconst url = req.url!;\nconst id = parts.pop()!;\n',
      );
      expect(res?.ok).toBe(false);
      if (res && !res.ok) {
        expect(res.message).toMatch(/TypeScript-only syntax/);
        expect(res.message).toMatch(/non-null assertion/);
      }
    });

    it('FAILS on TypeScript annotations and type-only imports in .js files', () => {
      const annotated = validateSourceContent(
        'server.js',
        'import type { IncomingMessage } from "node:http";\nfunction handle(req: IncomingMessage) {}\n',
      );
      expect(annotated?.ok).toBe(false);
      if (annotated && !annotated.ok) expect(annotated.message).toMatch(/TypeScript-only syntax/);
    });

    it('does not confuse normal JavaScript ! operators with non-null assertions', () => {
      const res = validateSourceContent(
        'logic.mjs',
        'const ok = !done && value !== null;\nif (!ok) throw new Error("bad");\n',
      );
      expect(res?.ok).toBe(true);
    });
  });

  describe('JSX', () => {
    it('passes a clean .jsx component', () => {
      const res = validateSourceContent(
        'Hello.jsx',
        'export function Hello() { return <div className="x">hi</div>; }\n',
      );
      expect(res?.ok).toBe(true);
    });

    it('FAILS on unterminated JSX', () => {
      const res = validateSourceContent(
        'Broken.jsx',
        'export function X() { return <div>hi<span></div>; }\n',
      );
      expect(res?.ok).toBe(false);
    });
  });

  describe('TS', () => {
    it('passes a clean .ts file', () => {
      const res = validateSourceContent(
        'lib.ts',
        'export function add(a: number, b: number): number { return a + b; }\n',
      );
      expect(res?.ok).toBe(true);
    });

    it('passes TS with `as const` and interfaces', () => {
      const res = validateSourceContent(
        'types.ts',
        'export interface User { id: string }\nexport const ROLES = ["admin", "user"] as const;\n',
      );
      expect(res?.ok).toBe(true);
    });

    it('does NOT fail on type errors (we only check syntax)', () => {
      // `notAFunction()` is a semantic error, not a syntax error.
      // Per the design intent, semantic diagnostics are out of scope.
      const res = validateSourceContent(
        'app.ts',
        'const x: number = "string";\nconst y = notAFunction();\n',
      );
      expect(res?.ok).toBe(true);
    });

    it('FAILS on unterminated brace in TS', () => {
      const res = validateSourceContent(
        'app.ts',
        'export function f(x: number): number {\n  return x + 1;\n// missing closing brace\n',
      );
      expect(res?.ok).toBe(false);
    });
  });

  describe('TSX', () => {
    it('passes a clean .tsx component', () => {
      const res = validateSourceContent(
        'Hello.tsx',
        'export function Hello(props: { name: string }) { return <span>{props.name}</span>; }\n',
      );
      expect(res?.ok).toBe(true);
    });

    it('FAILS on unterminated TSX', () => {
      const res = validateSourceContent(
        'Broken.tsx',
        'export function X() { return <div>hi<span></div>; }\n',
      );
      expect(res?.ok).toBe(false);
    });
  });
});
