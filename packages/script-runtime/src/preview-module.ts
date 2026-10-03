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
  const output = ts.transpileModule(source, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: format === 'esm' ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      isolatedModules: true,
      allowJs: true,
      jsx: ts.JsxEmit.React,
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
