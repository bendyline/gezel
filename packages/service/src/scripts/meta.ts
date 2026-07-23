import { readFile } from 'node:fs/promises';
import { type ScriptMeta, ScriptMetaSchema } from '@bendyline/gezel';
import ts from 'typescript';

/**
 * Extract the `meta` block from a script file **without executing the
 * script body**. We parse the source with TypeScript's AST and look for:
 *
 *   export const meta = defineScript({...});
 *   export const meta = defineScript({...} as const);
 *   export const meta = {...};
 *
 * Only literal object shapes are accepted — the meta block is metadata,
 * not runtime logic. Spreads, computed keys, and function calls inside
 * the literal are rejected so the extractor can't run arbitrary code.
 */

export class ScriptMetaError extends Error {
  constructor(
    message: string,
    readonly scriptPath: string,
  ) {
    super(message);
    this.name = 'ScriptMetaError';
  }
}

export async function readScriptMeta(scriptPath: string): Promise<ScriptMeta> {
  const source = await readFile(scriptPath, 'utf8');
  return parseScriptMeta(source, scriptPath);
}

export function parseScriptMeta(source: string, scriptPath: string): ScriptMeta {
  const sf = ts.createSourceFile(scriptPath, source, ts.ScriptTarget.ES2022, true);

  const expr = findMetaExpression(sf);
  if (!expr) {
    throw new ScriptMetaError(
      `script does not export a "meta" const. Every script must declare \`export const meta = defineScript({...})\`.`,
      scriptPath,
    );
  }

  const literal = unwrapMetaCall(expr);
  if (!ts.isObjectLiteralExpression(literal)) {
    throw new ScriptMetaError(
      `meta must be an object literal (optionally wrapped in defineScript(...) or "as const"), got ${ts.SyntaxKind[literal.kind]}.`,
      scriptPath,
    );
  }

  const raw = literalToValue(literal, scriptPath);
  const parsed = ScriptMetaSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ScriptMetaError(`meta did not validate:\n${issues}`, scriptPath);
  }
  return parsed.data;
}

function findMetaExpression(sf: ts.SourceFile): ts.Expression | null {
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const isExported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!isExported) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      if (decl.name.text !== 'meta') continue;
      if (!decl.initializer) return null;
      return decl.initializer;
    }
  }
  return null;
}

function unwrapMetaCall(expr: ts.Expression): ts.Expression {
  let cur: ts.Expression = expr;
  while (true) {
    if (ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isCallExpression(cur)) {
      const callee = cur.expression;
      if (ts.isIdentifier(callee) && callee.text === 'defineScript' && cur.arguments.length >= 1) {
        cur = cur.arguments[0]!;
        continue;
      }
      throw new ScriptMetaError(
        `meta must be a plain object or defineScript(...). Got call to "${describeCallee(callee)}".`,
        '<meta>',
      );
    }
    return cur;
  }
}

function describeCallee(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) return expr.text;
  return ts.SyntaxKind[expr.kind] ?? 'unknown';
}

function literalToValue(node: ts.Expression, scriptPath: string): unknown {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return literalToValue(node.expression, scriptPath);
  }
  if (ts.isParenthesizedExpression(node)) {
    return literalToValue(node.expression, scriptPath);
  }
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const inner = literalToValue(node.operand, scriptPath);
    if (typeof inner !== 'number') {
      throw new ScriptMetaError('unary minus only supported on numeric literals', scriptPath);
    }
    return -inner;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((el) => {
      if (ts.isSpreadElement(el)) {
        throw new ScriptMetaError('spread is not supported in meta', scriptPath);
      }
      return literalToValue(el, scriptPath);
    });
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out: Record<string, unknown> = {};
    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop)) {
        throw new ScriptMetaError(
          `only "key: value" properties are allowed in meta; got ${ts.SyntaxKind[prop.kind]}`,
          scriptPath,
        );
      }
      const key = propertyName(prop.name, scriptPath);
      out[key] = literalToValue(prop.initializer, scriptPath);
    }
    return out;
  }
  throw new ScriptMetaError(
    `unsupported expression kind in meta: ${ts.SyntaxKind[node.kind]}`,
    scriptPath,
  );
}

function propertyName(name: ts.PropertyName, scriptPath: string): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  throw new ScriptMetaError(
    `computed property keys are not allowed in meta (${ts.SyntaxKind[name.kind]})`,
    scriptPath,
  );
}
