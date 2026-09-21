import { compilePortableScript } from '@bendyline/gezel-script-runtime/compile';
import ts from 'typescript';

const capabilities = new Set([
  'workspace.read',
  'workspace.write',
  'artifacts.read',
  'artifacts.write',
  'documents.read',
  'documents.write',
  'tasks.read',
  'tasks.write',
]);
const members = new Set([
  'output',
  'log',
  'projectId',
  'runId',
  'script.run',
  ...['read', 'write', 'list', 'listAll', 'stat', 'rm', 'mkdir', 'rename'].map(
    (name) => `fs.${name}`,
  ),
  ...['read', 'write', 'list', 'delete'].map((name) => `artifacts.${name}`),
  ...['read', 'write', 'list', 'delete'].map((name) => `documents.${name}`),
  ...['get', 'steps', 'currentStep', 'readNotes', 'writeNotes', 'appendNote'].map(
    (name) => `task.${name}`,
  ),
]);
/** Conservative packaging eligibility, not an authorization boundary. The runtime rechecks every call. */
export function supportsPortableScriptSource(
  name: string,
  source: string,
  installedScripts?: ReadonlySet<string>,
): boolean {
  let compiled: ReturnType<typeof compilePortableScript>;
  try {
    compiled = compilePortableScript(source, name);
  } catch {
    return false;
  }
  if (
    !compiled.javascript ||
    !compiled.meta ||
    compiled.meta.requires?.some((capability) => !capabilities.has(capability))
  )
    return false;
  const file = ts.createSourceFile(`${name}.ts`, source, ts.ScriptTarget.ES2022, true);
  const sdkNames = new Set<string>();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== '@bendyline/gezel-sdk'
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const specifier of bindings.elements)
        if ((specifier.propertyName ?? specifier.name).text === 'gezel')
          sdkNames.add(specifier.name.text);
  }
  let supported = true;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)
    ) {
      const parts: string[] = [];
      let root: ts.Expression = node;
      while (ts.isPropertyAccessExpression(root)) {
        parts.unshift(root.name.text);
        root = root.expression;
      }
      if (ts.isIdentifier(root) && sdkNames.has(root.text)) {
        const member = parts.join('.');
        if (parts[0] !== 'input' && !members.has(member)) supported = false;
        if (member === 'script.run') {
          const call = node.parent;
          const child =
            ts.isCallExpression(call) && call.expression === node ? call.arguments[0] : undefined;
          // Bundled recipes may call only their known installed project helpers.
          // Authored runtime calls still resolve dynamically through the host.
          if (!child || !ts.isStringLiteralLike(child) || !installedScripts?.has(child.text))
            supported = false;
        }
      }
    }
    if (
      ts.isIdentifier(node) &&
      sdkNames.has(node.text) &&
      !ts.isImportSpecifier(node.parent) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)
    )
      supported = false;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return supported;
}
