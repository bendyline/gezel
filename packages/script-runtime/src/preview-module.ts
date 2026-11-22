import ts from 'typescript';

/** One import the compiled code still makes. `start`/`end` bound the specifier's text in `code`. */
export interface PreviewModuleImport {
  specifier: string;
  start: number;
  end: number;
}

export interface CompiledPreviewModule {
  code: string;
  /** Type-only imports are gone: the compiler dropped them, so nothing loads them. */
  imports: PreviewModuleImport[];
  /** Syntax errors, and code the requested format cannot run. */
  errors: string[];
}

/**
 * Compiles one project file for a workspace preview. `esm` keeps the module's
 * imports for a host that serves each file at its own URL (the desktop);
 * `commonjs` turns them into `require` calls for a host that links the files
 * into one script (the phones). JavaScript passes through the same compiler,
 * so a plain `.js` module is linked the same way. Types are only stripped,
 * never checked: a type error must not keep a game from running.
 */
export function compilePreviewModule(
  source: string,
  path: string,
  format: 'esm' | 'commonjs',
): CompiledPreviewModule {
  const runtime = jsxRuntimeFor(source, path);
  const output = ts.transpileModule(source, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: format === 'esm' ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      isolatedModules: true,
      allowJs: true,
      // A module that imports React or Preact gets their automatic runtime,
      // as Vite would compile it, so it need not import React to use JSX.
      // One that imports neither uses the page's global React.
      ...(runtime
        ? { jsx: ts.JsxEmit.ReactJSX, jsxImportSource: runtime }
        : { jsx: ts.JsxEmit.React }),
    },
  });
  const errors = (output.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => describe(diagnostic, path));
  if (format === 'commonjs') {
    const awaited = topLevelAwait(source, path);
    if (awaited) errors.push(awaited);
  }
  const code = output.outputText;
  const imports: PreviewModuleImport[] = [];
  for (const file of ts.preProcessFile(code, true, true).importedFiles) {
    // The reported range starts at the opening quote.
    const start = /["'`]/.test(code[file.pos] ?? '') ? file.pos + 1 : file.pos;
    const end = start + file.fileName.length;
    if (code.slice(start, end) === file.fileName)
      imports.push({ specifier: file.fileName, start, end });
  }
  return { code, imports, errors };
}

/**
 * The imports a file makes, at their offsets in the source as written: static
 * `import` and `export … from`, and `import()` of a literal. For a file that
 * is served as it stands and only has an address swapped, so nothing is
 * re-emitted. It reads the syntax tree, where `compilePreviewModule`'s list
 * comes from a text scan that is only safe on the compiler's own output: on
 * hand-minified code a regex literal holding a quote hides every import
 * after it.
 */
export function scanPreviewModuleImports(source: string, path: string): PreviewModuleImport[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, false);
  const imports: PreviewModuleImport[] = [];
  const add = (node: ts.Node | undefined): void => {
    if (!node || !(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return;
    const start = node.getStart(file) + 1;
    const end = node.end - 1;
    if (source.slice(start, end) === node.text) imports.push({ specifier: node.text, start, end });
  };
  const visit = (node: ts.Node): void => {
    // `import type` loads nothing; the compiler drops it.
    if (ts.isImportDeclaration(node)) {
      if (!node.importClause?.isTypeOnly) add(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly) add(node.moduleSpecifier);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return imports;
}

/** The automatic JSX runtime a JSX file is compiled for, or null for the classic `React.createElement`. */
function jsxRuntimeFor(source: string, path: string): 'react' | 'preact' | null {
  if (!/\.(?:[cm]?tsx|jsx)$/i.test(path)) return null;
  const imported = ts
    .preProcessFile(source, true, false)
    .importedFiles.map((file) => file.fileName);
  if (imported.some((name) => name === 'preact' || name.startsWith('preact/'))) return 'preact';
  if (
    imported.some(
      (name) =>
        name === 'react' ||
        name.startsWith('react/') ||
        name === 'react-dom' ||
        name.startsWith('react-dom/'),
    )
  )
    return 'react';
  // A script (no imports or exports: Babel's in-page JSX) and a module that
  // reaches for a global `React` both use the page's React from a script tag.
  // Any other JSX module is written for React's automatic runtime, as Vite
  // compiles it: a component file need not import React to use JSX, and
  // React 19 sets no global for the classic runtime to find.
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  return isModule(file) && !namesGlobalReact(file) ? 'react' : null;
}

function isModule(file: ts.SourceFile): boolean {
  return file.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) ||
      ts.isImportEqualsDeclaration(statement) ||
      ts.isExportDeclaration(statement) ||
      ts.isExportAssignment(statement) ||
      (ts.canHaveModifiers(statement) &&
        (ts.getModifiers(statement) ?? []).some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        )),
  );
}

function namesGlobalReact(file: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === 'React') {
      const parent = node.parent;
      // `obj.React` is a property, not the global.
      if (!(parent && ts.isPropertyAccessExpression(parent) && parent.name === node)) found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function describe(diagnostic: ts.Diagnostic, path: string): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
  if (diagnostic.file && diagnostic.start !== undefined) {
    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `${path}:${line + 1}:${character + 1} ${message}`;
  }
  return `${path}: ${message}`;
}

/**
 * A linked module runs inside a plain function, where `await` at the top
 * level is a syntax error, and the compiler does not object to it on its own.
 */
function topLevelAwait(source: string, path: string): string | undefined {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true);
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (found || ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node)) return;
    if (
      ts.isAwaitExpression(node) ||
      (ts.isForOfStatement(node) && node.awaitModifier !== undefined)
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) return undefined;
  const { line, character } = file.getLineAndCharacterOfPosition(found.getStart(file));
  return `${path}:${line + 1}:${character + 1} uses await outside a function, which this preview cannot run. Move it into an async function.`;
}
