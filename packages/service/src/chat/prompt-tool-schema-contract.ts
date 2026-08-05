import ts from 'typescript';
import type {
  PromptToolContractFinding,
  PromptToolContractReport,
} from './prompt-tool-contract.js';

export interface ToolInputContract {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallStringCorpusEntry {
  line: number;
  text: string;
}

const WILDCARD = Symbol('prompt-tool-schema-wildcard');
type SymbolicValue =
  | null
  | boolean
  | number
  | string
  | typeof WILDCARD
  | SymbolicValue[]
  | { [key: string]: SymbolicValue };

interface ExtractedCall {
  tool: string;
  text: string;
  line: number;
  lineText: string;
}

interface ParsedCall {
  value?: SymbolicValue;
  argumentCount: number;
  supported: boolean;
}

const NEGATIVE_EXAMPLE_PREFIX =
  /\b(?:do not|don't|never|avoid|instead of|bad|wrong|invalid|malformed|anti-pattern)\b/i;
const NEGATIVE_EXAMPLE_SUFFIX = /\b(?:is|are|would be)\s+(?:bad|wrong|invalid|malformed)\b/i;

/**
 * Validate literal model-facing tool-call examples against the exact JSON
 * Schemas returned by MCP `tools/list`. Identifiers and angle/ellipsis
 * placeholders are symbolic wildcards: their runtime value cannot be known,
 * but surrounding object shape, required keys, concrete types, enums, and
 * additional-property rules are still checked.
 */
export function lintPromptToolSchemaContract(args: {
  prompt: string;
  toolContracts: ReadonlyArray<ToolInputContract>;
}): PromptToolContractReport {
  const schemas = new Map(args.toolContracts.map((tool) => [tool.name, tool.inputSchema]));
  const findings: PromptToolContractFinding[] = [];
  const seen = new Set<string>();

  for (const call of extractToolCalls(args.prompt, [...schemas.keys()])) {
    const schema = schemas.get(call.tool);
    if (!schema || isNegativeExample(call)) continue;
    const parsed = parseCall(call.text);
    // Generic prose such as `tool({ ...arguments... })` deliberately leaves
    // values unspecified. The extractor validates every parseable structural
    // fragment without pretending an ellipsis is executable JSON.
    if (!parsed.supported) continue;

    if (
      parsed.argumentCount !== 1 ||
      parsed.value === null ||
      parsed.value === WILDCARD ||
      Array.isArray(parsed.value) ||
      typeof parsed.value !== 'object'
    ) {
      addSchemaFinding(
        findings,
        seen,
        call,
        'tool-example-argument-shape',
        `Example for \`${call.tool}\` must pass one JSON object matching its input schema.`,
      );
      continue;
    }

    const issues = validateSchemaValue(parsed.value, schema, schema, '$');
    if (issues.length > 0) {
      addSchemaFinding(
        findings,
        seen,
        call,
        'tool-example-schema-mismatch',
        `Example for \`${call.tool}\` violates its input schema: ${issues.slice(0, 3).join('; ')}`,
      );
    }
  }

  return { errors: findings, warnings: [] };
}

/**
 * Pull string and template-literal bodies out of TypeScript source so build
 * linting can cover model-facing MCP result messages as well as the rendered
 * standing prompt. Comments and executable expressions are intentionally not
 * treated as prompt text.
 */
export function extractToolCallStringCorpus(args: {
  sourceText: string;
  toolNames: ReadonlyArray<string>;
}): ToolCallStringCorpusEntry[] {
  const source = ts.createSourceFile(
    'tool-call-corpus.ts',
    args.sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const entries: ToolCallStringCorpusEntry[] = [];

  const visit = (node: ts.Node): void => {
    let text: string | undefined;
    if (ts.isStringLiteralLike(node)) {
      text = node.text;
    } else if (ts.isTemplateExpression(node)) {
      text = node.head.text;
      for (const span of node.templateSpans) {
        text += `__GEZEL_SCHEMA_PLACEHOLDER__${span.literal.text}`;
      }
    }
    if (text && containsToolCall(text, args.toolNames)) {
      entries.push({
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        text,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return entries;
}

function extractToolCalls(prompt: string, toolNames: ReadonlyArray<string>): ExtractedCall[] {
  if (toolNames.length === 0) return [];
  const escaped = [...toolNames]
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const matcher = new RegExp(`(?<![A-Za-z0-9_])(${escaped.join('|')})\\s*\\(`, 'g');
  const calls: ExtractedCall[] = [];
  for (const match of prompt.matchAll(matcher)) {
    if (match.index === undefined) continue;
    const open = prompt.indexOf('(', match.index + match[0].length - 1);
    const close = matchingParen(prompt, open);
    if (open < 0 || close < 0) continue;
    const lineStart = prompt.lastIndexOf('\n', match.index) + 1;
    const nextNewline = prompt.indexOf('\n', close);
    const lineEnd = nextNewline < 0 ? prompt.length : nextNewline;
    calls.push({
      tool: match[1]!,
      text: prompt.slice(match.index, close + 1),
      line: prompt.slice(0, match.index).split('\n').length,
      lineText: prompt.slice(lineStart, lineEnd),
    });
  }
  return calls;
}

function containsToolCall(text: string, toolNames: ReadonlyArray<string>): boolean {
  return toolNames.some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![A-Za-z0-9_])${escaped}\\s*\\(`).test(text);
  });
}

function matchingParen(text: string, open: number): number {
  if (open < 0 || text[open] !== '(') return -1;
  let depth = 0;
  let quote: '"' | "'" | '`' | undefined;
  let escaped = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function isNegativeExample(call: ExtractedCall): boolean {
  const column = call.lineText.indexOf(call.text);
  const prefix = column >= 0 ? call.lineText.slice(Math.max(0, column - 120), column) : '';
  const suffix =
    column >= 0
      ? call.lineText.slice(column + call.text.length, column + call.text.length + 80)
      : '';
  return NEGATIVE_EXAMPLE_PREFIX.test(prefix) || NEGATIVE_EXAMPLE_SUFFIX.test(suffix);
}

function parseCall(text: string): ParsedCall {
  if (/\.\.\./.test(text)) {
    return { argumentCount: 0, supported: false };
  }
  const normalized = text.replace(/<[^>\r\n]+>/g, '__GEZEL_SCHEMA_PLACEHOLDER__');
  const source = ts.createSourceFile(
    'tool-example.ts',
    `${normalized};`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const parseDiagnostics = (source as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  if (parseDiagnostics && parseDiagnostics.length > 0) {
    return { argumentCount: 0, supported: false };
  }
  const statement = source.statements[0];
  if (!statement || !ts.isExpressionStatement(statement)) {
    return { argumentCount: 0, supported: false };
  }
  const expression = unwrapExpression(statement.expression);
  if (!ts.isCallExpression(expression)) return { argumentCount: 0, supported: false };
  if (expression.arguments.length === 0) {
    return { argumentCount: 0, value: {}, supported: true };
  }
  // Some local models are trained on Python-style keyword calls inside
  // native tool tokens: `write_file(path='x', content='y')`. TypeScript
  // parses each `name=value` as an assignment expression. Treat a complete
  // keyword-argument list as the one object MCP receives so the contract
  // matrix validates the keys and values instead of falsely reporting
  // positional arguments.
  if (
    expression.arguments.every(
      (argument) =>
        ts.isBinaryExpression(argument) &&
        argument.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(argument.left),
    )
  ) {
    const value: Record<string, SymbolicValue> = {};
    for (const argument of expression.arguments) {
      const assignment = argument as ts.BinaryExpression;
      const converted = expressionValue(assignment.right);
      if (!converted.supported) return { argumentCount: 1, supported: false };
      value[(assignment.left as ts.Identifier).text] = converted.value;
    }
    return { argumentCount: 1, value, supported: true };
  }
  if (expression.arguments.length !== 1) {
    return { argumentCount: expression.arguments.length, supported: true };
  }
  const converted = expressionValue(expression.arguments[0]!);
  return {
    argumentCount: 1,
    ...(converted.supported ? { value: converted.value } : {}),
    supported: converted.supported,
  };
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function expressionValue(expression: ts.Expression): { supported: boolean; value: SymbolicValue } {
  const node = unwrapExpression(expression);
  if (ts.isStringLiteralLike(node)) return { supported: true, value: node.text };
  if (ts.isNumericLiteral(node)) return { supported: true, value: Number(node.text) };
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { supported: true, value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { supported: true, value: false };
  if (node.kind === ts.SyntaxKind.NullKeyword) return { supported: true, value: null };
  if (ts.isIdentifier(node) || ts.isTemplateExpression(node)) {
    return { supported: true, value: WILDCARD };
  }
  if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(node.operand)
  ) {
    const number = Number(node.operand.text);
    return {
      supported: true,
      value: node.operator === ts.SyntaxKind.MinusToken ? -number : number,
    };
  }
  if (ts.isArrayLiteralExpression(node)) {
    const values: SymbolicValue[] = [];
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) return { supported: false, value: WILDCARD };
      const converted = expressionValue(element);
      if (!converted.supported) return { supported: false, value: WILDCARD };
      values.push(converted.value);
    }
    return { supported: true, value: values };
  }
  if (ts.isObjectLiteralExpression(node)) {
    const value: Record<string, SymbolicValue> = {};
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property) || ts.isMethodDeclaration(property)) {
        return { supported: false, value: WILDCARD };
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        value[property.name.text] = WILDCARD;
        continue;
      }
      if (!ts.isPropertyAssignment(property)) return { supported: false, value: WILDCARD };
      const name = propertyName(property.name);
      if (name === undefined) return { supported: false, value: WILDCARD };
      const converted = expressionValue(property.initializer);
      if (!converted.supported) return { supported: false, value: WILDCARD };
      value[name] = converted.value;
    }
    return { supported: true, value };
  }
  return { supported: true, value: WILDCARD };
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function validateSchemaValue(
  value: SymbolicValue,
  schemaValue: unknown,
  rootSchema: Record<string, unknown>,
  path: string,
): string[] {
  if (value === WILDCARD || schemaValue === true || schemaValue === undefined) return [];
  if (schemaValue === false) return [`${path} is forbidden by the schema`];
  if (!isRecord(schemaValue)) return [];
  const schema = schemaValue;

  if (typeof schema.$ref === 'string') {
    const resolved = resolveJsonPointer(rootSchema, schema.$ref);
    if (resolved === undefined) return [`${path} uses unresolved schema reference ${schema.$ref}`];
    return validateSchemaValue(value, resolved, rootSchema, path);
  }
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.flatMap((branch) => validateSchemaValue(value, branch, rootSchema, path));
  }
  if (Array.isArray(schema.anyOf)) {
    const attempts = schema.anyOf.map((branch) =>
      validateSchemaValue(value, branch, rootSchema, path),
    );
    if (!attempts.some((issues) => issues.length === 0)) {
      return [`${path} does not match any allowed schema branch`];
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter(
      (branch) => validateSchemaValue(value, branch, rootSchema, path).length === 0,
    ).length;
    if (matches === 0 || (!containsWildcard(value) && matches !== 1)) {
      return [`${path} does not match exactly one allowed schema branch`];
    }
  }
  if (schema.not !== undefined && !containsWildcard(value)) {
    if (validateSchemaValue(value, schema.not, rootSchema, path).length === 0) {
      return [`${path} matches a forbidden schema branch`];
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => deepEqual(value, candidate))) {
    return [`${path} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}`];
  }
  if ('const' in schema && !deepEqual(value, schema.const)) {
    return [`${path} must equal ${JSON.stringify(schema.const)}`];
  }

  const allowedTypes = Array.isArray(schema.type)
    ? schema.type.filter((type): type is string => typeof type === 'string')
    : typeof schema.type === 'string'
      ? [schema.type]
      : [];
  if (allowedTypes.length > 0 && !allowedTypes.some((type) => matchesType(value, type))) {
    return [`${path} must be ${allowedTypes.join(' or ')}, received ${valueType(value)}`];
  }

  if (isRecord(value)) return validateObject(value, schema, rootSchema, path);
  if (Array.isArray(value)) return validateArray(value, schema, rootSchema, path);
  if (typeof value === 'string') return validateString(value, schema, path);
  if (typeof value === 'number') return validateNumber(value, schema, path);
  return [];
}

function validateObject(
  value: Record<string, SymbolicValue>,
  schema: Record<string, unknown>,
  rootSchema: Record<string, unknown>,
  path: string,
): string[] {
  const issues: string[] = [];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : [];
  for (const key of required) {
    if (!(key in value)) issues.push(`${path}.${key} is required`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key in properties) {
      issues.push(...validateSchemaValue(child, properties[key], rootSchema, `${path}.${key}`));
      continue;
    }
    if (schema.additionalProperties === false) {
      issues.push(`${path}.${key} is not an allowed property`);
    } else if (
      isRecord(schema.additionalProperties) ||
      typeof schema.additionalProperties === 'boolean'
    ) {
      issues.push(
        ...validateSchemaValue(child, schema.additionalProperties, rootSchema, `${path}.${key}`),
      );
    }
  }
  if (
    typeof schema.minProperties === 'number' &&
    Object.keys(value).length < schema.minProperties
  ) {
    issues.push(`${path} must contain at least ${schema.minProperties} properties`);
  }
  if (
    typeof schema.maxProperties === 'number' &&
    Object.keys(value).length > schema.maxProperties
  ) {
    issues.push(`${path} must contain at most ${schema.maxProperties} properties`);
  }
  return issues;
}

function validateArray(
  value: SymbolicValue[],
  schema: Record<string, unknown>,
  rootSchema: Record<string, unknown>,
  path: string,
): string[] {
  const issues: string[] = [];
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
    issues.push(`${path} must contain at least ${schema.minItems} items`);
  }
  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
    issues.push(`${path} must contain at most ${schema.maxItems} items`);
  }
  if (Array.isArray(schema.items)) {
    for (let index = 0; index < value.length && index < schema.items.length; index += 1) {
      issues.push(
        ...validateSchemaValue(value[index]!, schema.items[index], rootSchema, `${path}[${index}]`),
      );
    }
  } else if (schema.items !== undefined) {
    for (let index = 0; index < value.length; index += 1) {
      issues.push(
        ...validateSchemaValue(value[index]!, schema.items, rootSchema, `${path}[${index}]`),
      );
    }
  }
  return issues;
}

function validateString(value: string, schema: Record<string, unknown>, path: string): string[] {
  const issues: string[] = [];
  if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
    issues.push(`${path} must contain at least ${schema.minLength} characters`);
  }
  if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
    issues.push(`${path} must contain at most ${schema.maxLength} characters`);
  }
  if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
    issues.push(`${path} must match /${schema.pattern}/`);
  }
  return issues;
}

function validateNumber(value: number, schema: Record<string, unknown>, path: string): string[] {
  const issues: string[] = [];
  if (typeof schema.minimum === 'number' && value < schema.minimum) {
    issues.push(`${path} must be >= ${schema.minimum}`);
  }
  if (typeof schema.maximum === 'number' && value > schema.maximum) {
    issues.push(`${path} must be <= ${schema.maximum}`);
  }
  if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
    issues.push(`${path} must be > ${schema.exclusiveMinimum}`);
  }
  if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
    issues.push(`${path} must be < ${schema.exclusiveMaximum}`);
  }
  return issues;
}

function resolveJsonPointer(root: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let current: unknown = root;
  for (const rawPart of ref.slice(2).split('/')) {
    if (!isRecord(current)) return undefined;
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
    current = current[part];
  }
  return current;
}

function matchesType(value: SymbolicValue, type: string): boolean {
  if (value === WILDCARD) return true;
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isRecord(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  return false;
}

function valueType(value: SymbolicValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value === WILDCARD) return 'placeholder';
  return typeof value;
}

function containsWildcard(value: SymbolicValue): boolean {
  if (value === WILDCARD) return true;
  if (Array.isArray(value)) return value.some(containsWildcard);
  if (isRecord(value)) return Object.values(value).some(containsWildcard);
  return false;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === WILDCARD) return true;
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => deepEqual(item, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => key in right && deepEqual(left[key], right[key]))
    );
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, SymbolicValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addSchemaFinding(
  findings: PromptToolContractFinding[],
  seen: Set<string>,
  call: ExtractedCall,
  rule: 'tool-example-argument-shape' | 'tool-example-schema-mismatch',
  detail: string,
): void {
  const key = `${rule}:${call.tool}:${call.line}:${call.text}`;
  if (seen.has(key)) return;
  seen.add(key);
  findings.push({
    severity: 'error',
    rule,
    tool: call.tool,
    line: call.line,
    detail,
    excerpt: compactExcerpt(call.lineText),
  });
}

function compactExcerpt(text: string): string {
  const compact = text.trim().replace(/\s+/g, ' ');
  return compact.length <= 220 ? compact : `${compact.slice(0, 217)}…`;
}
