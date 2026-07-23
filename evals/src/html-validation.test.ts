import { describe, expect, it } from 'vitest';
import {
  MIN_INLINE_JS_BYTES,
  detectUnclosedScript,
  extractInlineScripts,
  validateScriptSyntax,
} from './html-validation.ts';

describe('extractInlineScripts', () => {
  it('pulls every inline <script> body in document order', () => {
    const html =
      '<html><head><script>const a = 1;</script></head>' +
      '<body><script>console.log(a);</script></body></html>';
    const scripts = extractInlineScripts(html);
    expect(scripts).toHaveLength(2);
    expect(scripts[0]!.body).toBe('const a = 1;');
    expect(scripts[1]!.body).toBe('console.log(a);');
  });

  it('skips <script src="…"> entries with no inline body', () => {
    const html = '<script src="app.js"></script><script>const x = 1;</script>';
    const scripts = extractInlineScripts(html);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.body).toBe('const x = 1;');
  });

  it('skips JSON-LD and other non-JS script types', () => {
    const html =
      '<script type="application/ld+json">{"@type":"Thing"}</script>' +
      '<script>const x = 2;</script>';
    const scripts = extractInlineScripts(html);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.body).toBe('const x = 2;');
  });

  it('keeps `type="module"` scripts', () => {
    const html = '<script type="module">import { x } from "./x.js";</script>';
    const scripts = extractInlineScripts(html);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.attrs).toContain('type="module"');
  });

  it('returns empty list for HTML with no <script> at all', () => {
    expect(extractInlineScripts('<html><body>hello</body></html>')).toEqual([]);
  });
});

describe('validateScriptSyntax', () => {
  it('returns allParse=true and the right total bytes for valid JS', () => {
    const scripts = extractInlineScripts(
      '<script>const a = 1; function add(x, y) { return x + y; }</script>',
    );
    const v = validateScriptSyntax(scripts);
    expect(v.allParse).toBe(true);
    expect(v.totalBytes).toBeGreaterThan(0);
    expect(v.firstError).toBeUndefined();
  });

  it('catches the wild-caught truncated `let|` case', () => {
    // Mirrors the wild tankcombat output (qwen3.6 trial):
    // a long-looking HTML whose JS ends mid-declaration. The previous
    // tank-combat sniff scored this as "passing" because all the
    // keyword signals were present.
    const truncated =
      '<script>const C=document.getElementById("c"); let player,enemies,bullets;let|</script>';
    const v = validateScriptSyntax(extractInlineScripts(truncated));
    expect(v.allParse).toBe(false);
    expect(v.firstError).toMatch(/Unexpected|Unterminated|Invalid|token/i);
  });

  it('catches an unclosed brace mid-game-loop', () => {
    const truncated = '<script>function update() { for (const e of enemies) { e.x++;</script>';
    const v = validateScriptSyntax(extractInlineScripts(truncated));
    expect(v.allParse).toBe(false);
  });

  it('skips parse for `type="module"` scripts (top-level import is fine in browser)', () => {
    // `import` at top level fails `new Function` parsing — but a real
    // browser module would accept it. Skip parse for modules; the
    // browser render in the next layer catches genuine errors.
    const scripts = extractInlineScripts(
      '<script type="module">import { x } from "./mod.js"; console.log(x);</script>',
    );
    const v = validateScriptSyntax(scripts);
    expect(v.allParse).toBe(true);
    expect(v.totalBytes).toBeGreaterThan(0);
  });

  it('per-script status preserves order and bytes', () => {
    const html = '<script>const a = 1;</script><script>let|</script><script>const c = 3;</script>';
    const v = validateScriptSyntax(extractInlineScripts(html));
    expect(v.perScript.map((s) => s.parses)).toEqual([true, false, true]);
    expect(v.perScript[1]!.error).toBeTruthy();
  });

  it('zero scripts → allParse=true, totalBytes=0 (caller decides if that meets minimum)', () => {
    const v = validateScriptSyntax([]);
    expect(v.allParse).toBe(true);
    expect(v.totalBytes).toBe(0);
  });

  it('MIN_INLINE_JS_BYTES is 2048', () => {
    // Pinned so a refactor that changes the floor requires an
    // explicit test update. Calibrated against a wild
    // working tic-tac-toe at 2495 bytes; the prior 4096 rejected
    // valid working games.
    expect(MIN_INLINE_JS_BYTES).toBe(2048);
  });
});

describe('detectUnclosedScript', () => {
  it('returns unclosed=true when <script> opens but never closes', () => {
    // Wild-caught (qwen3.6 matrix): all 7 produced HTMLs
    // ended mid-script with no `</script>` tag. The strict regex in
    // `extractInlineScripts` silently dropped the body, leading the
    // old sniff to report "js=0 bytes" which made it look like the
    // model never tried to write JS at all.
    const html = '<html><body><h1>Game</h1><script>const x = 1;\nfunction';
    const r = detectUnclosedScript(html);
    expect(r.opens).toBe(1);
    expect(r.closes).toBe(0);
    expect(r.unclosed).toBe(true);
  });

  it('returns unclosed=false for well-formed HTML', () => {
    const html = '<html><body><script>const x = 1;</script></body></html>';
    const r = detectUnclosedScript(html);
    expect(r.unclosed).toBe(false);
    expect(r.opens).toBe(1);
    expect(r.closes).toBe(1);
  });

  it('returns unclosed=false for HTML with no scripts', () => {
    const html = '<html><body><p>Hello</p></body></html>';
    const r = detectUnclosedScript(html);
    expect(r.unclosed).toBe(false);
    expect(r.opens).toBe(0);
    expect(r.closes).toBe(0);
  });

  it('handles multiple scripts: closes match opens', () => {
    const html = '<script>const a = 1;</script><script>const b = 2;</script>';
    const r = detectUnclosedScript(html);
    expect(r.unclosed).toBe(false);
    expect(r.opens).toBe(2);
    expect(r.closes).toBe(2);
  });

  it('handles two opens but only one close (mid-stream cutoff after second open)', () => {
    const html = '<script>const a = 1;</script><script>const b = 2; for (let i = 0; i < 10';
    const r = detectUnclosedScript(html);
    expect(r.unclosed).toBe(true);
    expect(r.opens).toBe(2);
    expect(r.closes).toBe(1);
  });
});
