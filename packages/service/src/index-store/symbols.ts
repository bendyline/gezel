import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { ImportBinding, ImportEdgeInput, SymbolInput } from './index-store.js';

/**
 * Deterministic symbol extraction. Code goes through web-tree-sitter
 * (grammar wasms from `tree-sitter-wasms`); markdown uses a heading scan; other
 * text types yield nothing. A tree walk (rather than tree-sitter queries) keeps
 * us tolerant to grammar-version drift — we recognise a small set of node types
 * and read their `name` field, skipping anything unfamiliar.
 *
 * The whole module degrades gracefully: if web-tree-sitter fails to init or a
 * grammar fails to load, `extractCodeSymbols` returns null and the caller falls
 * back (no symbols for that file rather than a crash).
 */

const nodeRequire = createRequire(import.meta.url);

const SIG_CAP = 160;

// langId (from classify.ts) → grammar wasm filename in tree-sitter-wasms/out.
const GRAMMAR_FILE: Record<string, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  jsx: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm',
  c: 'tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  c_sharp: 'tree-sitter-c_sharp.wasm',
  php: 'tree-sitter-php.wasm',
  bash: 'tree-sitter-bash.wasm',
  lua: 'tree-sitter-lua.wasm',
  swift: 'tree-sitter-swift.wasm',
  kotlin: 'tree-sitter-kotlin.wasm',
  scala: 'tree-sitter-scala.wasm',
};

// node type → symbol kind. Covers the common definition nodes across the
// grammars above; unknown types are recursed through (so e.g. export_statement
// and decorated_definition wrappers are transparent).
const NODE_KIND: Record<string, string> = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  function_definition: 'function',
  method_definition: 'method',
  method_declaration: 'method',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  class_definition: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
  struct_item: 'struct',
  function_item: 'function',
  impl_item: 'impl',
  trait_item: 'trait',
  // ruby
  module: 'module',
  // swift
  protocol_declaration: 'protocol',
  // kotlin
  object_declaration: 'object',
  // scala
  object_definition: 'object',
  trait_definition: 'trait',
};

const CONTAINER_KINDS = new Set([
  'class',
  'interface',
  'impl',
  'trait',
  'module',
  'object',
  'protocol',
]);

// Grammars without a `name` field on declaration nodes (kotlin, some swift
// nodes) put the identifier among the named children instead.
const NAME_CHILD_TYPES = new Set(['identifier', 'simple_identifier', 'type_identifier']);

function symbolName(node: TsNode): string | undefined {
  const field = node.childForFieldName('name')?.text;
  if (field) return field;
  return node.namedChildren.find((c) => NAME_CHILD_TYPES.has(c.type))?.text;
}

interface TsNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  namedChildren: TsNode[];
  childForFieldName(field: string): TsNode | null;
}
interface TsTree {
  rootNode: TsNode;
  // web-tree-sitter trees own WASM heap allocations and must be freed
  // explicitly — they are not GC-managed.
  delete?(): void;
}
interface TsParser {
  setLanguage(lang: unknown): void;
  parse(code: string): TsTree;
  // Same WASM ownership as TsTree: free the parser when done.
  delete?(): void;
}

let initPromise: Promise<boolean> | null = null;
let ParserCtor: (new () => TsParser) | null = null;
let LanguageMod: { load(path: string): Promise<unknown> } | null = null;
const langCache = new Map<string, unknown | null>();

async function ensureInit(): Promise<boolean> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const mod = nodeRequire('web-tree-sitter') as {
        Parser: {
          init(opts?: { locateFile?: (f: string) => string }): Promise<void>;
        } & (new () => TsParser);
        Language: { load(path: string): Promise<unknown> };
      };
      const wtsDir = dirname(nodeRequire.resolve('web-tree-sitter'));
      await mod.Parser.init({ locateFile: (f: string) => join(wtsDir, f) });
      ParserCtor = mod.Parser as unknown as new () => TsParser;
      LanguageMod = mod.Language;
      return true;
    } catch {
      return false;
    }
  })();
  return initPromise;
}

function grammarDir(): string {
  return join(dirname(nodeRequire.resolve('tree-sitter-wasms/package.json')), 'out');
}

async function loadLanguage(langId: string): Promise<unknown | null> {
  const file = GRAMMAR_FILE[langId];
  if (!file) return null;
  if (langCache.has(langId)) return langCache.get(langId) ?? null;
  let lang: unknown | null = null;
  try {
    lang = await LanguageMod!.load(join(grammarDir(), file));
  } catch {
    lang = null;
  }
  langCache.set(langId, lang);
  return lang;
}

/** True when this language has a grammar we can parse. */
export function isCodeLangSupported(langId: string | null): boolean {
  return !!langId && langId in GRAMMAR_FILE;
}

/**
 * Extract code symbols. Returns null when tree-sitter is unavailable or the
 * grammar can't load (caller treats as "no symbols"). Returns [] for a parseable
 * file with no recognised definitions.
 */
export async function extractCodeSymbols(
  langId: string,
  code: string,
): Promise<SymbolInput[] | null> {
  if (!(await ensureInit()) || !ParserCtor) return null;
  const lang = await loadLanguage(langId);
  if (!lang) return null;

  let parser: TsParser;
  let tree: TsTree;
  try {
    parser = new ParserCtor();
    parser.setLanguage(lang);
    tree = parser.parse(code);
  } catch {
    return null;
  }

  const out: SymbolInput[] = [];
  const visit = (node: TsNode, parent: string | undefined): void => {
    for (const child of node.namedChildren) {
      const kind = NODE_KIND[child.type];
      if (kind) {
        const name = symbolName(child);
        if (name) {
          out.push({
            name,
            kind,
            lineStart: child.startPosition.row + 1,
            lineEnd: child.endPosition.row + 1,
            signature: firstLine(child.text),
            ...(parent ? { parent } : {}),
          });
        }
        if (CONTAINER_KINDS.has(kind)) visit(child, name ?? parent);
      } else if (child.type === 'variable_declarator' || child.type === 'assignment') {
        // `const foo = () => …` / `const Bar = function () {}`
        const value = child.childForFieldName('value');
        if (value && (value.type === 'arrow_function' || value.type === 'function_expression')) {
          const name = child.childForFieldName('name')?.text;
          if (name) {
            out.push({
              name,
              kind: 'function',
              lineStart: child.startPosition.row + 1,
              lineEnd: child.endPosition.row + 1,
              signature: firstLine(child.text),
              ...(parent ? { parent } : {}),
            });
          }
        }
      } else {
        visit(child, parent); // transparent wrapper (export_statement, program, …)
      }
    }
  };
  try {
    visit(tree.rootNode, undefined);
    return out;
  } finally {
    // Free the WASM-owned tree + parser; they are not garbage-collected.
    tree.delete?.();
    parser.delete?.();
  }
}

/**
 * Extract raw module specifiers — the map's dependency "roads" — from a source
 * file, plus the named bindings each import takes where the grammar lets us see
 * them (JS/TS/TSX fully; Python best-effort; other languages record the edge
 * with `bindings` undefined, which downstream treats as a whole-module import).
 * Best-effort and additive: recognises the common import forms across the
 * supported grammars; unknown shapes yield nothing. Resolving a specifier to a
 * repo file happens later (build time), where the full path set is known.
 * Returns null when tree-sitter is unavailable (caller treats as "no edges");
 * [] for a parseable file with none.
 */
export async function extractImportEdges(
  langId: string,
  code: string,
): Promise<ImportEdgeInput[] | null> {
  if (!(await ensureInit()) || !ParserCtor) return null;
  const lang = await loadLanguage(langId);
  if (!lang) return null;

  let parser: TsParser;
  let tree: TsTree;
  try {
    parser = new ParserCtor();
    parser.setLanguage(lang);
    tree = parser.parse(code);
  } catch {
    return null;
  }

  // Merge across statements importing the same specifier. null (bindings not
  // recorded) is absorbing: it means "whole module" and named info from a
  // sibling statement can't refine that.
  const out = new Map<string, ImportBinding[] | null>();
  const add = (raw: string, bindings: ImportBinding[] | null): void => {
    const s = raw.trim();
    if (!s) return;
    const prev = out.get(s);
    if (prev === undefined) {
      out.set(s, bindings ? [...bindings] : null);
      return;
    }
    if (prev === null || bindings === null) {
      out.set(s, null);
      return;
    }
    for (const b of bindings) {
      if (!prev.some((p) => p.kind === b.kind && p.name === b.name && p.local === b.local)) {
        prev.push(b);
      }
    }
  };
  const visit = (node: TsNode): void => {
    for (const child of node.namedChildren) {
      for (const edge of edgesFor(child)) add(edge.raw, edge.bindings);
      visit(child);
    }
  };
  try {
    visit(tree.rootNode);
    return [...out].map(([raw, bindings]) => ({ raw, ...(bindings ? { bindings } : {}) }));
  } finally {
    tree.delete?.();
    parser.delete?.();
  }
}

function unquote(text: string): string {
  return text
    .trim()
    .replace(/^[`'"]/, '')
    .replace(/[`'"]$/, '');
}

const NAMESPACE_BINDING: ImportBinding = { name: '*', local: '*', kind: 'namespace' };

/**
 * The import edge(s) introduced by a single node, by grammar shape. `bindings`
 * is null when the language's imports aren't destructured (whole-module), [] when
 * the statement demonstrably takes no names (side-effect import). Fully tolerant
 * to grammar drift: a missing child degrades to fewer bindings, never a throw.
 */
function edgesFor(node: TsNode): Array<{ raw: string; bindings: ImportBinding[] | null }> {
  switch (node.type) {
    case 'import_statement': {
      // JS/TS: a `source` string field. Python: `import a.b, c as d` dotted names.
      const src = node.childForFieldName('source');
      if (src) return [{ raw: unquote(src.text), bindings: jsImportClauseBindings(node) }];
      return node.namedChildren
        .filter((c) => c.type === 'dotted_name' || c.type === 'aliased_import')
        .map((c) => {
          if (c.type === 'aliased_import') {
            const name = (c.childForFieldName('name')?.text ?? c.text).trim();
            const alias = c.childForFieldName('alias')?.text.trim();
            return {
              raw: name,
              bindings: [
                {
                  name: '*',
                  local: alias ?? name.split('.')[0] ?? name,
                  kind: 'namespace' as const,
                },
              ],
            };
          }
          const raw = c.text.trim();
          // `import a.b` binds `a` in scope.
          return {
            raw,
            bindings: [{ name: '*', local: raw.split('.')[0] ?? raw, kind: 'namespace' as const }],
          };
        });
    }
    case 'import_from_statement': {
      // Python: `from a.b import c, d as e` / `from a import *`.
      const m = node.childForFieldName('module_name');
      if (!m) return [];
      const isModuleNode = (c: TsNode): boolean =>
        c.startPosition.row === m.startPosition.row &&
        c.startPosition.column === m.startPosition.column;
      const bindings: ImportBinding[] = [];
      for (const c of node.namedChildren) {
        if (isModuleNode(c)) continue;
        if (c.type === 'dotted_name') {
          const name = c.text.trim();
          if (name) bindings.push({ name, local: name, kind: 'named' });
        } else if (c.type === 'aliased_import') {
          const name = c.childForFieldName('name')?.text.trim();
          const alias = c.childForFieldName('alias')?.text.trim();
          if (name) bindings.push({ name, local: alias ?? name, kind: 'named' });
        } else if (c.type === 'wildcard_import') {
          bindings.push({ ...NAMESPACE_BINDING });
        }
      }
      return [{ raw: m.text.trim(), bindings }];
    }
    case 'export_statement': {
      // Re-export: `export … from 'x'` (plain exports have no source).
      const src = node.childForFieldName('source');
      if (!src) return [];
      const bindings: ImportBinding[] = [];
      let sawClause = false;
      for (const c of node.namedChildren) {
        if (c.type === 'export_clause') {
          sawClause = true;
          for (const spec of c.namedChildren) {
            if (spec.type !== 'export_specifier') continue;
            const name = spec.childForFieldName('name')?.text.trim();
            const alias = spec.childForFieldName('alias')?.text.trim();
            if (name) bindings.push({ name, local: alias ?? name, kind: 'named' });
          }
        } else if (c.type === 'namespace_export') {
          // `export * as ns from 'x'`
          sawClause = true;
          const id = c.namedChildren.find(
            (n) => NAME_CHILD_TYPES.has(n.type) || n.type === 'string',
          );
          bindings.push({ name: '*', local: id ? unquote(id.text) : '*', kind: 'namespace' });
        }
      }
      // Bare `export * from 'x'` has neither clause node — whole module.
      if (!sawClause && !bindings.length) bindings.push({ ...NAMESPACE_BINDING });
      return [{ raw: unquote(src.text), bindings }];
    }
    case 'call_expression': {
      // `require('x')` / dynamic `import('x')` — takes the whole module.
      // Only constant specifiers: an interpolated template ships its literal
      // `${…}` text, which nothing downstream can resolve (and which used to
      // surface verbatim in the dependency inventory).
      const fn = node.childForFieldName('function')?.text;
      if (fn !== 'require' && fn !== 'import') return [];
      const args = node.childForFieldName('arguments');
      const str = args?.namedChildren.find(
        (c) =>
          c.type === 'string' ||
          (c.type === 'template_string' &&
            !c.namedChildren.some((n) => n.type === 'template_substitution')),
      );
      return str ? [{ raw: unquote(str.text), bindings: [{ ...NAMESPACE_BINDING }] }] : [];
    }
    case 'import_spec': {
      // Go: a single import line; the path is an interpreted string.
      const p =
        node.childForFieldName('path') ?? node.namedChildren.find((c) => c.type.includes('string'));
      return p ? [{ raw: unquote(p.text), bindings: null }] : [];
    }
    case 'use_declaration': {
      // Rust: `use crate::a::b;` — capture the path (usually resolves external).
      const arg = node.namedChildren[0];
      return arg ? [{ raw: arg.text.replace(/\s+/g, ''), bindings: null }] : [];
    }
    case 'preproc_include': {
      // C/C++: `#include <x>` / `"x"`.
      const s = node.namedChildren.find(
        (c) => c.type === 'string_literal' || c.type === 'system_lib_string',
      );
      return s ? [{ raw: s.text.replace(/^[<"]/, '').replace(/[>"]$/, ''), bindings: null }] : [];
    }
    default:
      return [];
  }
}

/** Bindings introduced by a JS/TS `import …` statement's import_clause. */
function jsImportClauseBindings(importNode: TsNode): ImportBinding[] {
  const clause = importNode.namedChildren.find((c) => c.type === 'import_clause');
  if (!clause) return []; // side-effect import: `import './x.js'`
  const out: ImportBinding[] = [];
  for (const c of clause.namedChildren) {
    if (c.type === 'identifier') {
      out.push({ name: 'default', local: c.text, kind: 'default' });
    } else if (c.type === 'namespace_import') {
      const id = c.namedChildren.find((n) => n.type === 'identifier');
      if (id) out.push({ name: '*', local: id.text, kind: 'namespace' });
    } else if (c.type === 'named_imports') {
      for (const spec of c.namedChildren) {
        if (spec.type !== 'import_specifier') continue;
        const name = spec.childForFieldName('name')?.text.trim();
        const alias = spec.childForFieldName('alias')?.text.trim();
        if (name) out.push({ name, local: alias ?? name, kind: 'named' });
      }
    }
  }
  return out;
}

/** Markdown/heading outline — no tree-sitter needed. */
export function extractMarkdownOutline(code: string): SymbolInput[] {
  const lines = code.split(/\r?\n/);
  const headings: Array<{ name: string; level: number; line: number }> = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) headings.push({ name: m[2]!, level: m[1]!.length, line: i + 1 });
  }
  return headings.map((h, idx) => {
    const next = headings.slice(idx + 1).find((n) => n.level <= h.level);
    const lineEnd = next ? next.line - 1 : lines.length;
    return {
      name: h.name,
      kind: `h${h.level}`,
      lineStart: h.line,
      lineEnd,
      signature: `${'#'.repeat(h.level)} ${h.name}`.slice(0, SIG_CAP),
    };
  });
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? '';
  return line.trim().slice(0, SIG_CAP);
}
