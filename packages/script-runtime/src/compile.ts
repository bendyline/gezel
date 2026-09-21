import type { ScriptDiagnostic, ScriptMeta } from '@bendyline/gezel';
import ts from 'typescript';
import { parseScriptMeta } from './meta.js';
import { computeScriptDiagnostics } from './source.js';

export interface PortableScriptCompilation {
  javascript?: string;
  meta?: ScriptMeta;
  diagnostics: ScriptDiagnostic[];
}
export const PORTABLE_SCRIPT_MAX_SOURCE_CHARS = 256_000;
const modules = new Set(['@bendyline/gezel-sdk', '@bendyline/gezel-sdk/checks']);
/** A trusted compiler, run in a dedicated Worker. It never evaluates source or resolves imports. */
export function compilePortableScript(source: string, name: string): PortableScriptCompilation {
  if (source.length > PORTABLE_SCRIPT_MAX_SOURCE_CHARS)
    throw new Error('Script source exceeds 256000 characters');
  const file = `${name}.ts`;
  const diagnostics = computeScriptDiagnostics(source, file, name);
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  const reject = (node: ts.Node, message: string) => {
    const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    diagnostics.push({
      source: 'runtime-compat',
      severity: 'error',
      message,
      line: pos.line + 1,
      column: pos.character + 1,
    });
  };
  const visit = (node: ts.Node) => {
    let specifier: ts.Expression | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      specifier = node.moduleSpecifier;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      specifier = node.arguments[0];
    if (specifier && (!ts.isStringLiteralLike(specifier) || !modules.has(specifier.text)))
      reject(
        specifier,
        'This device permits only the bundled @bendyline/gezel-sdk and @bendyline/gezel-sdk/checks imports.',
      );
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    )
      reject(node, 'CommonJS and native modules are unavailable; use the bundled gezel SDK.');
    ts.forEachChild(node, visit);
  };
  visit(sf);
  let meta: ScriptMeta | undefined;
  try {
    meta = parseScriptMeta(source, file);
  } catch {
    /* Shared diagnostic already contains the error. */
  }
  if (meta && meta.name !== name)
    diagnostics.push({
      source: 'meta',
      severity: 'error',
      message: 'The script metadata name must match its file name.',
    });
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error'))
    return { meta, diagnostics };
  const compiled = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      isolatedModules: true,
    },
  });
  return { meta, diagnostics, javascript: compiled.outputText };
}
