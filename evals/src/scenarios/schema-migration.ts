import { writeFile as fsWriteFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { GezelClient } from '@bendyline/gezel-client/node';
import ts from 'typescript';
import { postSniffFeedback } from '../sniff-feedback.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import { materializeProjectWorkspace, provisionScenarioGezel, spawnAndAwait } from './helpers.ts';

/**
 * Schema migration — multi-file coordinated TypeScript refactor.
 *
 * Tests **planning + execution + verification**. The seeded codebase has
 * a `User.name: string` field used by a store and three handlers. The
 * brief asks for a breaking change: split `name` into `firstName` +
 * `lastName`. A naive model that just rewrites `types.ts` from scratch
 * will leave `.name` accesses surviving in `store.ts` and `handlers.ts`
 * — `tsc --noEmit` will catch it.
 *
 * The scenario's defining trait is the **`tsc-clean` gate**: it's not
 * a regex sniff, it's an objective compiler signal. The model has to
 * read every file before editing, then write tests, then a migration
 * doc. Six coordinated files vs one HTML in the legacy trio.
 *
 * Implementation choices:
 *   - Fixtures live inline (mirrors `self-correction.ts`'s BROKEN_HTML).
 *     The fixture footprint is small enough (~1 KB / file) and inlining
 *     keeps the scenario self-contained — no fixture directory traversal
 *     at runtime.
 *   - `tsc` is invoked via the eval package's own `typescript` devDep
 *     (resolved through `createRequire`), so trials don't `npm install`
 *     anything per-trial. The model writes source files; the
 *     successCheck spawns tsc on them.
 *   - Model-authored tests are not executed as arbitrary code. The harness
 *     parses `tests/migrate.test.ts` to require three distinct cases that call
 *     the imported migration contract with legacy record objects, then runs a
 *     harness-owned strict TypeScript config over source + that exact test file.
 *   - A separate harness-owned runtime probe executes only the production
 *     `migrateUser` export against hidden records. It proves every seeded
 *     non-name User field is preserved, the legacy `name` field is removed,
 *     and the requested split behavior is real rather than self-asserted by
 *     model-authored tests.
 */

const PROJECT_NAME = 'User Store';
const DEVELOPER_NAME = 'Riley';
export const SCHEMA_MIGRATION_TEST_PATH = 'tests/migrate.test.ts';

const TEST_TSC_CONFIG_PATH = '.gezel-eval-tests-tsconfig.json';
const TEST_VITEST_SHIM_PATH = '.gezel-eval-vitest.d.ts';
const MIGRATION_GATE_CONFIG_PATH = '.gezel-eval-migration-tsconfig.json';
const MIGRATION_GATE_PROBE_PATH = '.gezel-eval-migration-probe.ts';
const MIGRATION_GATE_OUT_DIR = '.gezel-eval-migration-out';
const MIGRATION_GATE_MARKER = 'GEZEL_SCHEMA_MIGRATION_GATE:';

// Harness-owned: never extend the candidate tsconfig, whose exclude list or
// relaxed options could otherwise hide a generated-test contract mismatch.
const TEST_TSC_GATE_CONFIG_JSON = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "esModuleInterop": true
  },
  "include": ["src/**/*.ts", "${SCHEMA_MIGRATION_TEST_PATH}", "${TEST_VITEST_SHIM_PATH}"],
  "exclude": ["node_modules"]
}
`;

// The temp workspace deliberately has no node_modules. The DSL is typed as
// `any` so the gate checks the candidate's own source/test contracts rather
// than failing on whichever Vitest matcher surface a model chose.
const TEST_VITEST_SHIM_TS = `declare module 'vitest' {
  export const afterAll: any;
  export const afterEach: any;
  export const beforeAll: any;
  export const beforeEach: any;
  export const describe: any;
  export const expect: any;
  export const it: any;
  export const test: any;
  export const vi: any;
}
`;

// Resolve the evals package's typescript binary path. The eval harness
// already depends on `typescript@5.x` (devDep) so we don't need an
// install step — we just point spawn at the locally-resolved tsc.
const requireFromHere = createRequire(import.meta.url);
function resolveTscBin(): string {
  const tscPkg = requireFromHere.resolve('typescript/package.json');
  return join(dirname(tscPkg), 'bin', 'tsc');
}

// ─────────────────────────────────────────────────────────────────────
// Fixture files seeded into the project workspace before the trial
// kicks off. Each file is intentionally small + clear so the diff
// between "starting state" and "target state" is unambiguous.

const PKG_JSON = `{
  "name": "user-store",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
`;

const TSCONFIG_JSON = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "esModuleInterop": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["tests/**/*", "node_modules"]
}
`;

const TYPES_TS = `// Domain types for the user store.
//
// NOTE: the User record uses a single \`name: string\` field today, but
// product wants to split it into \`firstName\` + \`lastName\`. See
// MIGRATION.md (to be written) for the migration plan.

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface CreateUserInput {
  name: string;
  email: string;
}
`;

const STORE_TS = `import type { CreateUserInput, User } from './types.ts';

let nextId = 1;

/**
 * Tiny in-memory user store. Three methods consumers care about: \`add\`,
 * \`get\`, and \`list\`. The \`name\` field is currently a single string;
 * touching this code is part of the rename migration.
 */
export class UserStore {
  private readonly users = new Map<string, User>();

  add(input: CreateUserInput): User {
    const id = String(nextId++);
    const user: User = { id, name: input.name, email: input.email };
    this.users.set(id, user);
    return user;
  }

  get(id: string): User | undefined {
    return this.users.get(id);
  }

  list(): User[] {
    return Array.from(this.users.values()).sort((a, b) => a.name.localeCompare(b.name));
  }
}
`;

const HANDLERS_TS = `import type { User } from './types.ts';

/**
 * Three handler functions that read User.name. They each format the
 * user for a different UI surface; the migration must update each
 * call site.
 */

export function formatDisplayName(user: User): string {
  return user.name;
}

export function renderUserCardHtml(user: User): string {
  return \`<div class="user-card"><h3>\${user.name}</h3><p>\${user.email}</p></div>\`;
}

export function summarizeUsersForLog(users: User[]): string {
  return users.map((u) => \`\${u.id}: \${u.name}\`).join(', ');
}
`;

const README_MD = `# user-store

A tiny in-memory user store.

Current shape:

\`\`\`ts
interface User {
  id: string;
  name: string;   // ← will split into firstName + lastName
  email: string;
}
\`\`\`

Run the typecheck:

\`\`\`bash
npm run typecheck
\`\`\`
`;

// ─────────────────────────────────────────────────────────────────────

async function findProjectId(client: GezelClient): Promise<string | null> {
  const { projects } = await client.listProjects();
  return projects.find((p) => p.name === PROJECT_NAME)?.id ?? null;
}

async function readWorkspaceText(
  client: GezelClient,
  projectId: string,
  filePath: string,
): Promise<string | null> {
  try {
    const blob = await client.fetchProjectWorkspaceBlob(projectId, filePath);
    return await blob.text();
  } catch {
    return null;
  }
}

async function setup(ctx: EvalContext): Promise<void> {
  const { client, log } = ctx;
  let projectId = await findProjectId(client);
  if (!projectId) {
    const created = await client.createProject({
      name: PROJECT_NAME,
      about:
        'A tiny TypeScript codebase with an in-memory User store. The product needs a ' +
        "breaking change: the User record's `name: string` field must split into " +
        '`firstName: string` and `lastName: string` (no optional fields, no compatibility shim). ' +
        'The codebase has a store and three call-site handlers that read `.name`; every ' +
        'reference must be updated.',
      missionObjectives: [
        '1. Read every file under src/ before editing.',
        '2. Update src/types.ts so User has firstName + lastName (no name).',
        '3. Update src/store.ts and src/handlers.ts so they use the new fields.',
        '4. Write src/migrate.ts exporting `migrateUser(old)` that splits old.name on the first space while preserving id, email, and every other non-name field from the legacy User record.',
        '5. Write tests/migrate.test.ts with at least 3 vitest cases that call migrateUser with full legacy `{ id, name, email }` records: normal, one-word, and multi-word; assert id/email preservation as well as the split name.',
        '6. Write MIGRATION.md describing the change (≥ 1 KB).',
        '7. `npx tsc --noEmit` must pass with zero errors.',
      ].join(' '),
    });
    projectId = created.id;
    log(`[scenario:setup] created project name="${PROJECT_NAME}" id=${projectId}`);
  } else {
    log(`[scenario:setup] reusing existing project id=${projectId}`);
  }
  if (!projectId) throw new Error('schema-migration setup: failed to resolve project id');

  // Seed the fixture files. Each write goes to the project workspace
  // so the recruited Developer can read them via read_file(path: "src/types.ts").
  const seedFiles: Array<{ path: string; content: string }> = [
    { path: 'package.json', content: PKG_JSON },
    { path: 'tsconfig.json', content: TSCONFIG_JSON },
    { path: 'src/types.ts', content: TYPES_TS },
    { path: 'src/store.ts', content: STORE_TS },
    { path: 'src/handlers.ts', content: HANDLERS_TS },
    { path: 'README.md', content: README_MD },
    { path: 'tests/.gitkeep', content: '' },
  ];
  for (const f of seedFiles) {
    await client.writeProjectWorkspaceFile(projectId, f);
  }
  log(`[scenario:setup] seeded ${seedFiles.length} fixture files under project ${projectId}`);

  // Pre-recruit Riley as the Developer joined to this project. Mirrors
  // self-correction.ts — small models that can't navigate the multi-hop
  // delegation (Meester → recruit → join → assign) shouldn't fail on
  // *that* axis; we want them to fail (or pass) on the actual refactor.
  // No hand-written about: the service resolves the shipped Developer
  // template (product-shaped prompt). Task specifics live in the kickoff
  // message below — the eval measures the product configuration, not a
  // scenario-tuned system prompt.
  const riley = await provisionScenarioGezel(ctx, {
    preferredName: DEVELOPER_NAME,
    role: 'Developer',
    label: 'developer',
  });
  await client.addGezelToProject(projectId, riley.id);
  log(`[scenario:setup] joined ${riley.name} to project ${projectId}`);

  // Send the kickoff to Riley in the project session directly — same
  // reasoning as self-correction.ts: routing through the Meester drops
  // the project-scoped about + workspace context.
  await client.sendChatMessage(riley.id, {
    message: [
      "Please carry out the User schema migration: split the User schema's `name`",
      'field into `firstName` + `lastName` across every source file that touches it.',
      'Start by reading every file under src/ — src/types.ts, src/store.ts, and',
      'src/handlers.ts, plus tsconfig.json (paths are relative to the workspace root,',
      'no leading "workspace/"). Update each one, write src/migrate.ts (a',
      '`migrateUser(old)` function that splits the name on the first space while',
      'preserving id, email, and every other non-name field from the legacy record),',
      'tests/migrate.test.ts with at least 3 vitest cases that call migrateUser with',
      'full legacy `{ id, name, email }` records (normal, one-word, and multi-word),',
      'asserting preserved id/email plus the split name, and MIGRATION.md (at least',
      '1 KB describing the change). Do not overwrite tsconfig.json or package.json.',
      'Do NOT try to run npm install',
      'or shell commands — there is no node_modules; harness-owned strict typechecks run',
      'automatically against both source and tests, and errors are reported back via chat.',
      "Just write the six target files and you're done.",
    ].join(' '),
    projectId,
  });
  log(`[scenario:setup] sent kickoff message to ${riley.name} in project ${projectId}`);
}

// Tracks tsc-clean transitions across polls so we don't re-spawn tsc
// on every 5 s tick when the source files haven't changed. Keyed by a
// content hash of the relevant files.
const tscRunCache = new WeakMap<
  EvalContext,
  { lastHash: string; lastResult: boolean; firstError?: string }
>();

export interface SchemaMigrationTestTypecheckResult {
  ok: boolean;
  exitCode: number | null;
  firstError?: string;
  timedOut: boolean;
}

export interface SchemaMigrationFunctionGateResult {
  ok: boolean;
  stage: 'typecheck' | 'runtime' | 'pass';
  exitCode: number | null;
  firstError?: string;
  timedOut: boolean;
}

const testTscRunCache = new WeakMap<
  EvalContext,
  { lastHash: string; lastResult: SchemaMigrationTestTypecheckResult }
>();

const migrationFunctionRunCache = new WeakMap<
  EvalContext,
  { lastHash: string; lastResult: SchemaMigrationFunctionGateResult }
>();

const SCHEMA_SIGNAL_NAMES = [
  'types-updated',
  'store-updated',
  'handlers-updated',
  'migrate-function',
  'tests-present',
  'migration-doc',
  'tsc-clean',
] as const;

export interface SchemaMigrationStructuralSources {
  typesTs: string | null;
  storeTs: string | null;
  handlersTs: string | null;
}

export interface SchemaMigrationStructuralResult {
  typesUpdated: boolean;
  storeUpdated: boolean;
  handlersUpdated: boolean;
}

function sourceFileFor(text: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function staticPropertyName(name: ts.PropertyName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)) {
    return name.expression.text;
  }
  return null;
}

interface SeededPreservedUserField {
  name: string;
  kind: 'string' | 'number' | 'boolean';
}

/**
 * Derive the preservation contract from the seeded User fixture itself. A
 * future fixture field cannot silently fall out of the hidden migration gate:
 * supported primitive fields are probed automatically, while a new complex
 * field forces the scenario author to define an honest runtime fixture.
 */
function seededPreservedUserFields(): SeededPreservedUserField[] {
  const sourceFile = sourceFileFor(TYPES_TS, 'seed/src/types.ts');
  const user = sourceFile.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === 'User',
  );
  if (!user) throw new Error('schema-migration fixture is missing the User interface');

  const fields: SeededPreservedUserField[] = [];
  for (const member of user.members) {
    if (!ts.isPropertySignature(member) || member.questionToken) continue;
    const name = staticPropertyName(member.name);
    if (!name || name === 'name') continue;
    const kind =
      member.type?.kind === ts.SyntaxKind.StringKeyword
        ? 'string'
        : member.type?.kind === ts.SyntaxKind.NumberKeyword
          ? 'number'
          : member.type?.kind === ts.SyntaxKind.BooleanKeyword
            ? 'boolean'
            : null;
    if (!kind) {
      throw new Error(
        `schema-migration fixture field User.${name} needs an explicit hidden-probe value`,
      );
    }
    fields.push({ name, kind });
  }
  if (fields.length === 0) {
    throw new Error('schema-migration fixture has no non-name User fields to preserve');
  }
  return fields;
}

function seededProbeValue(field: SeededPreservedUserField, caseIndex: number): unknown {
  if (field.kind === 'number') return 41_000 + caseIndex;
  if (field.kind === 'boolean') return caseIndex % 2 === 0;
  return `${field.name}-sentinel-${caseIndex + 1}`;
}

function migrationFunctionProbeSource(): string {
  const preservedFields = seededPreservedUserFields();
  const nameCases = [
    { label: 'normal two-word', name: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace' },
    { label: 'one-word', name: 'Cher', firstName: 'Cher', lastName: '' },
    {
      label: 'multi-word',
      name: 'Mary Anne Smith',
      firstName: 'Mary',
      lastName: 'Anne Smith',
    },
  ];
  const cases = nameCases.map((nameCase, caseIndex) => ({
    ...nameCase,
    input: Object.fromEntries([
      ...preservedFields.map((field) => [field.name, seededProbeValue(field, caseIndex)]),
      ['name', nameCase.name],
    ]),
  }));

  return `import { migrateUser } from './src/migrate.ts';

const marker = ${JSON.stringify(MIGRATION_GATE_MARKER)};
const preservedFields = ${JSON.stringify(preservedFields.map((field) => field.name))};
const cases = ${JSON.stringify(cases)};
const runMigration = migrateUser as unknown as (
  oldUser: Record<string, unknown>,
) => unknown;

try {
  for (const testCase of cases) {
    const input = testCase.input as Record<string, unknown>;
    const result = runMigration(input);
    if (typeof result !== 'object' || result === null || Array.isArray(result)) {
      throw new Error(testCase.label + ': migrateUser must return one User object');
    }
    const migrated = result as Record<string, unknown>;
    for (const field of preservedFields) {
      if (migrated[field] !== input[field]) {
        throw new Error(
          testCase.label + ': migrateUser did not preserve ' + field +
          ' (expected ' + JSON.stringify(input[field]) +
          ', got ' + JSON.stringify(migrated[field]) + ')',
        );
      }
    }
    if (Object.prototype.hasOwnProperty.call(migrated, 'name')) {
      throw new Error(testCase.label + ': migrated User still has the legacy name field');
    }
    if (migrated.firstName !== testCase.firstName || migrated.lastName !== testCase.lastName) {
      throw new Error(
        testCase.label + ': wrong name split (expected ' +
        JSON.stringify({ firstName: testCase.firstName, lastName: testCase.lastName }) +
        ', got ' + JSON.stringify({ firstName: migrated.firstName, lastName: migrated.lastName }) + ')',
      );
    }
  }
  console.log(marker + JSON.stringify({ ok: true, cases: cases.length, preservedFields }));
} catch (error) {
  console.log(
    marker + JSON.stringify({
      ok: false,
      why: error instanceof Error ? error.message : String(error),
    }),
  );
}
`;
}

function migrationFunctionGateConfigJson(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ES2022',
        moduleResolution: 'bundler',
        strict: true,
        skipLibCheck: true,
        esModuleInterop: true,
        rewriteRelativeImportExtensions: true,
        rootDir: '.',
        outDir: MIGRATION_GATE_OUT_DIR,
      },
      include: ['src/types.ts', 'src/migrate.ts', MIGRATION_GATE_PROBE_PATH],
      exclude: ['node_modules'],
    },
    null,
    2,
  )}\n`;
}

/**
 * Return every member from a closed, inline object type. `null` means the
 * alias includes a referenced/mapped/conditional constituent whose members
 * cannot be proven from this source file. That distinction is load-bearing:
 * treating an unknown constituent as an empty member list would let
 * `type User = LegacyUser & { firstName: string; lastName: string }` pass
 * even though `LegacyUser` may still expose `name`.
 */
function directTypeMembers(node: ts.TypeNode): readonly ts.TypeElement[] | null {
  if (ts.isTypeLiteralNode(node)) return node.members;
  if (ts.isParenthesizedTypeNode(node)) return directTypeMembers(node.type);
  if (ts.isIntersectionTypeNode(node)) {
    const members: ts.TypeElement[] = [];
    for (const type of node.types) {
      const nested = directTypeMembers(type);
      if (nested === null) return null;
      members.push(...nested);
    }
    return members;
  }
  return null;
}

function contractHasMigratedNameFields(sourceFile: ts.SourceFile, contractName: string): boolean {
  let foundContract = false;
  let hasFirstName = false;
  let hasLastName = false;
  let hasLegacyName = false;
  let hasUnresolvedMembers = false;

  for (const statement of sourceFile.statements) {
    let members: readonly ts.TypeElement[] = [];
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === contractName) {
      foundContract = true;
      // `extends LegacyUser` can preserve a `name` property that is invisible
      // in this declaration. The gate requires a closed migrated contract, so
      // reject inheritance instead of assuming its inherited members are safe.
      if ((statement.heritageClauses?.length ?? 0) > 0) hasUnresolvedMembers = true;
      members = statement.members;
    } else if (ts.isTypeAliasDeclaration(statement) && statement.name.text === contractName) {
      foundContract = true;
      const directMembers = directTypeMembers(statement.type);
      if (directMembers === null) {
        hasUnresolvedMembers = true;
      } else {
        members = directMembers;
      }
    }

    for (const member of members) {
      const name = staticPropertyName(member.name);
      if (name === 'name') hasLegacyName = true;
      if (!ts.isPropertySignature(member) || member.questionToken) continue;
      if (member.type?.kind !== ts.SyntaxKind.StringKeyword) continue;
      if (name === 'firstName') hasFirstName = true;
      if (name === 'lastName') hasLastName = true;
    }
  }

  return foundContract && !hasUnresolvedMembers && hasFirstName && hasLastName && !hasLegacyName;
}

function runtimePropertyNames(root: ts.Node): Set<string> {
  const names = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      names.add(node.name.text);
    } else if (ts.isElementAccessExpression(node) && node.argumentExpression) {
      const argument = node.argumentExpression;
      if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
        names.add(argument.text);
      }
    } else if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      const name = staticPropertyName(node.name);
      if (name) names.add(name);
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const name = node.propertyName
        ? staticPropertyName(node.propertyName)
        : ts.isIdentifier(node.name)
          ? node.name.text
          : null;
      if (name) names.add(name);
    }
    ts.forEachChild(node, visit);
  };

  visit(root);
  return names;
}

function propertiesUseMigratedNameFields(properties: ReadonlySet<string>): boolean {
  return properties.has('firstName') && properties.has('lastName') && !properties.has('name');
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false)
  );
}

function isPublicInstanceMethod(
  member: ts.ClassElement,
  methodName: string,
): member is ts.MethodDeclaration {
  return (
    ts.isMethodDeclaration(member) &&
    staticPropertyName(member.name) === methodName &&
    !hasModifier(member, ts.SyntaxKind.PrivateKeyword) &&
    !hasModifier(member, ts.SyntaxKind.ProtectedKeyword) &&
    !hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
    member.body !== undefined
  );
}

function storeUsesMigratedApi(text: string | null): boolean {
  if (text === null) return false;
  const sourceFile = sourceFileFor(text, 'src/store.ts');
  const storeClass = sourceFile.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) &&
      statement.name?.text === 'UserStore' &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword),
  );
  if (!storeClass) return false;

  const add = storeClass.members.find((member) => isPublicInstanceMethod(member, 'add'));
  const get = storeClass.members.find((member) => isPublicInstanceMethod(member, 'get'));
  const list = storeClass.members.find((member) => isPublicInstanceMethod(member, 'list'));
  if (!add?.body || !get?.body || !list?.body) return false;

  const classProperties = runtimePropertyNames(storeClass);
  return (
    !classProperties.has('name') &&
    propertiesUseMigratedNameFields(runtimePropertyNames(add.body)) &&
    propertiesUseMigratedNameFields(runtimePropertyNames(list.body))
  );
}

type CallableExpression = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

function exportedCallable(
  sourceFile: ts.SourceFile,
  exportName: string,
): CallableExpression | null {
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === exportName &&
      statement.body &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword)
    ) {
      return statement;
    }
    if (
      !ts.isVariableStatement(statement) ||
      !hasModifier(statement, ts.SyntaxKind.ExportKeyword)
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== exportName) continue;
      if (
        declaration.initializer &&
        (ts.isArrowFunction(declaration.initializer) ||
          ts.isFunctionExpression(declaration.initializer))
      ) {
        return declaration.initializer;
      }
    }
  }
  return null;
}

function isNamedTypeReference(type: ts.TypeNode | undefined, name: string): boolean {
  return (
    type !== undefined &&
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    type.typeName.text === name &&
    (type.typeArguments?.length ?? 0) === 0
  );
}

function isArrayOfNamedType(type: ts.TypeNode | undefined, elementName: string): boolean {
  if (!type) return false;
  if (ts.isArrayTypeNode(type)) return isNamedTypeReference(type.elementType, elementName);
  return (
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    type.typeName.text === 'Array' &&
    type.typeArguments?.length === 1 &&
    isNamedTypeReference(type.typeArguments[0], elementName)
  );
}

function callableParameterName(
  callable: CallableExpression,
  parameterType: (type: ts.TypeNode | undefined) => boolean,
): string | null {
  if (callable.parameters.length !== 1) return null;
  const parameter = callable.parameters[0];
  if (!parameter) return null;
  if (
    !ts.isIdentifier(parameter.name) ||
    parameter.questionToken ||
    parameter.dotDotDotToken ||
    parameter.initializer !== undefined ||
    !parameterType(parameter.type) ||
    callable.type?.kind !== ts.SyntaxKind.StringKeyword
  ) {
    return null;
  }
  return parameter.name.text;
}

interface ReturnValueUsage {
  properties: Set<string>;
  calls: Set<string>;
}

function isCallableNode(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/**
 * Trace the candidate parameter's properties into returned expressions. This
 * follows simple local constants and object destructuring so a normal
 * `const fullName = ...; return fullName` implementation passes, while dead
 * reads or an unrelated dummy object cannot satisfy the handler contract.
 */
function returnValueUsage(callable: CallableExpression, parameterName: string): ReturnValueUsage {
  const body = callable.body;
  if (!body) return { properties: new Set(), calls: new Set() };

  const localInitializers = new Map<string, ts.Expression>();
  const destructuredProperties = new Map<string, string>();
  const collectLocals = (node: ts.Node): void => {
    if (node !== body && isCallableNode(node)) return;
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        localInitializers.set(node.name.text, node.initializer);
      } else if (
        ts.isObjectBindingPattern(node.name) &&
        ts.isIdentifier(node.initializer) &&
        node.initializer.text === parameterName
      ) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const propertyName = element.propertyName
            ? staticPropertyName(element.propertyName)
            : element.name.text;
          if (propertyName) destructuredProperties.set(element.name.text, propertyName);
        }
      }
    }
    ts.forEachChild(node, collectLocals);
  };
  collectLocals(body);

  const usage: ReturnValueUsage = { properties: new Set(), calls: new Set() };
  const resolvingLocals = new Set<string>();
  const collectUsage = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === parameterName
    ) {
      usage.properties.add(node.name.text);
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === parameterName &&
      node.argumentExpression &&
      (ts.isStringLiteral(node.argumentExpression) ||
        ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))
    ) {
      usage.properties.add(node.argumentExpression.text);
    } else if (ts.isIdentifier(node)) {
      const destructuredProperty = destructuredProperties.get(node.text);
      if (destructuredProperty) usage.properties.add(destructuredProperty);

      const initializer = localInitializers.get(node.text);
      if (initializer && !resolvingLocals.has(node.text)) {
        resolvingLocals.add(node.text);
        collectUsage(initializer);
        resolvingLocals.delete(node.text);
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.arguments.some(
        (argument) => ts.isIdentifier(argument) && argument.text === parameterName,
      )
    ) {
      usage.calls.add(node.expression.text);
    }
    ts.forEachChild(node, collectUsage);
  };

  if (ts.isArrowFunction(callable) && !ts.isBlock(body)) {
    collectUsage(body);
    return usage;
  }

  const collectReturns = (node: ts.Node): void => {
    if (node !== body && isCallableNode(node)) return;
    if (ts.isReturnStatement(node) && node.expression) {
      collectUsage(node.expression);
      return;
    }
    ts.forEachChild(node, collectReturns);
  };
  collectReturns(body);
  return usage;
}

function containsPropertyCall(root: ts.Node, propertyName: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === propertyName
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

interface SummaryHandlerStatus {
  actualUserId: boolean;
  fullName: boolean;
  joined: boolean;
}

function summaryHandlerStatus(
  callable: CallableExpression,
  collectionName: string,
): SummaryHandlerStatus {
  const mapStatuses: Array<{ actualUserId: boolean; fullName: boolean; score: number }> = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'map' &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === collectionName
    ) {
      const callback = node.arguments[0];
      const itemParameter =
        callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
          ? callback.parameters[0]
          : undefined;
      if (
        callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
        itemParameter &&
        ts.isIdentifier(itemParameter.name)
      ) {
        const itemName = itemParameter.name.text;
        const usage = returnValueUsage(callback, itemName);
        const actualUserId = usage.properties.has('id');
        const fullName =
          (usage.properties.has('firstName') && usage.properties.has('lastName')) ||
          usage.calls.has('formatDisplayName');
        const score = Number(actualUserId) + Number(fullName);
        mapStatuses.push({ actualUserId, fullName, score });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(callable.body!);
  const bestMap = mapStatuses.sort((a, b) => b.score - a.score)[0];
  return {
    actualUserId: bestMap?.actualUserId ?? false,
    fullName: bestMap?.fullName ?? false,
    joined: containsPropertyCall(callable.body!, 'join'),
  };
}

function forbiddenHandlerImports(sourceFile: ts.SourceFile): string[] {
  const forbidden = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name?.text === 'CreateUserInput' || clause.name?.text === 'UserStore') {
      forbidden.add(clause.name.text);
    }
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (importedName === 'CreateUserInput' || importedName === 'UserStore') {
          forbidden.add(importedName);
        }
      }
    }
  }
  return [...forbidden].sort();
}

export type SchemaMigrationHandlerSubcontract =
  | 'allowed-imports'
  | 'format-display-signature'
  | 'format-display-full-name'
  | 'render-card-signature'
  | 'render-card-full-name'
  | 'render-card-email'
  | 'summary-signature'
  | 'summary-actual-user-id'
  | 'summary-full-name'
  | 'summary-join'
  | 'no-legacy-name-access';

export interface SchemaMigrationHandlerDiagnostics {
  updated: boolean;
  bodiesPass: boolean;
  unmet: SchemaMigrationHandlerSubcontract[];
  forbiddenImports: string[];
}

export function evaluateSchemaMigrationHandlers(
  text: string | null,
): SchemaMigrationHandlerDiagnostics {
  if (text === null) {
    return {
      updated: false,
      bodiesPass: false,
      unmet: ['format-display-signature', 'render-card-signature', 'summary-signature'],
      forbiddenImports: [],
    };
  }
  const sourceFile = sourceFileFor(text, 'src/handlers.ts');
  const forbiddenImports = forbiddenHandlerImports(sourceFile);
  const unmet: SchemaMigrationHandlerSubcontract[] = [];
  if (forbiddenImports.length > 0) unmet.push('allowed-imports');

  const display = exportedCallable(sourceFile, 'formatDisplayName');
  const render = exportedCallable(sourceFile, 'renderUserCardHtml');
  const summarize = exportedCallable(sourceFile, 'summarizeUsersForLog');

  if (!display) {
    unmet.push('format-display-signature');
  } else {
    const displayParameter = callableParameterName(display, (type) =>
      isNamedTypeReference(type, 'User'),
    );
    if (!displayParameter) {
      unmet.push('format-display-signature');
    } else {
      const displayUsage = returnValueUsage(display, displayParameter);
      if (!propertiesUseMigratedNameFields(displayUsage.properties)) {
        unmet.push('format-display-full-name');
      }
    }
  }

  if (!render) {
    unmet.push('render-card-signature');
  } else {
    const renderParameter = callableParameterName(render, (type) =>
      isNamedTypeReference(type, 'User'),
    );
    if (!renderParameter) {
      unmet.push('render-card-signature');
    } else {
      const renderUsage = returnValueUsage(render, renderParameter);
      if (!propertiesUseMigratedNameFields(renderUsage.properties)) {
        unmet.push('render-card-full-name');
      }
      if (!renderUsage.properties.has('email')) unmet.push('render-card-email');
    }
  }

  if (!summarize) {
    unmet.push('summary-signature');
  } else {
    const summarizeParameter = callableParameterName(summarize, (type) =>
      isArrayOfNamedType(type, 'User'),
    );
    if (!summarizeParameter) {
      unmet.push('summary-signature');
    } else {
      const status = summaryHandlerStatus(summarize, summarizeParameter);
      if (!status.actualUserId) unmet.push('summary-actual-user-id');
      if (!status.fullName) unmet.push('summary-full-name');
      if (!status.joined) unmet.push('summary-join');
    }
  }

  const hasLegacyNameAccess = [display, render, summarize].some(
    (callable) => callable?.body && runtimePropertyNames(callable.body).has('name'),
  );
  if (hasLegacyNameAccess) unmet.push('no-legacy-name-access');

  const bodyUnmet = unmet.filter((subcontract) => subcontract !== 'allowed-imports');
  return {
    updated: unmet.length === 0,
    bodiesPass: bodyUnmet.length === 0,
    unmet,
    forbiddenImports,
  };
}

function handlersUseMigratedApi(text: string | null): boolean {
  return evaluateSchemaMigrationHandlers(text).updated;
}

/**
 * Evaluates the three coordinated source edits from TypeScript syntax, not raw text.
 * Comments and string contents therefore cannot create or invalidate a structural signal.
 */
export function evaluateSchemaMigrationStructure(
  sources: SchemaMigrationStructuralSources,
): SchemaMigrationStructuralResult {
  const typesSource =
    sources.typesTs === null ? null : sourceFileFor(sources.typesTs, 'src/types.ts');

  return {
    typesUpdated:
      typesSource !== null &&
      contractHasMigratedNameFields(typesSource, 'User') &&
      contractHasMigratedNameFields(typesSource, 'CreateUserInput'),
    storeUpdated: storeUsesMigratedApi(sources.storeTs),
    handlersUpdated: handlersUseMigratedApi(sources.handlersTs),
  };
}

export type SchemaMigrationTestSubcontract =
  | 'migrate-user-import'
  | 'three-test-cases'
  | 'legacy-record-arguments'
  | 'normal-full-name-case'
  | 'one-word-name-case'
  | 'multi-word-name-case';

export interface SchemaMigrationTestDiagnostics {
  updated: boolean;
  testCaseCount: number;
  validTestCaseCount: number;
  validLegacyRecordCallCount: number;
  invalidMigrateUserCallCount: number;
  coverage: {
    normalFullName: boolean;
    oneWordName: boolean;
    multiWordName: boolean;
  };
  unmet: SchemaMigrationTestSubcontract[];
}

function unwrapTestExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function simpleInitializers(root: ts.Node): Map<string, ts.Expression> {
  const initializers = new Map<string, ts.Expression>();
  const visit = (node: ts.Node): void => {
    // A test case's own callback body is passed as `root`; nested helpers have
    // separate scopes and must not overwrite the case's simple constants.
    if (node !== root && isCallableNode(node)) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      initializers.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return initializers;
}

function resolveStringValue(
  expression: ts.Expression,
  initializers: ReadonlyMap<string, ts.Expression>,
  resolving = new Set<string>(),
): string | null {
  const candidate = unwrapTestExpression(expression);
  if (ts.isStringLiteral(candidate) || ts.isNoSubstitutionTemplateLiteral(candidate)) {
    return candidate.text;
  }
  if (!ts.isIdentifier(candidate) || resolving.has(candidate.text)) return null;
  const initializer = initializers.get(candidate.text);
  if (!initializer) return null;
  resolving.add(candidate.text);
  const value = resolveStringValue(initializer, initializers, resolving);
  resolving.delete(candidate.text);
  return value;
}

interface ResolvedLegacyRecordArgument {
  name: string;
  properties: Set<string>;
}

function legacyRecordFromArgument(
  expression: ts.Expression,
  initializers: ReadonlyMap<string, ts.Expression>,
  resolving = new Set<string>(),
): ResolvedLegacyRecordArgument | null {
  const candidate = unwrapTestExpression(expression);
  if (ts.isIdentifier(candidate)) {
    if (resolving.has(candidate.text)) return null;
    const initializer = initializers.get(candidate.text);
    if (!initializer) return null;
    resolving.add(candidate.text);
    const value = legacyRecordFromArgument(initializer, initializers, resolving);
    resolving.delete(candidate.text);
    return value;
  }
  if (!ts.isObjectLiteralExpression(candidate)) return null;

  const properties = new Set<string>();
  let name: string | null = null;
  for (const property of candidate.properties) {
    if (ts.isPropertyAssignment(property)) {
      const propertyName = staticPropertyName(property.name);
      if (!propertyName) continue;
      properties.add(propertyName);
      if (propertyName === 'name') {
        name = resolveStringValue(property.initializer, initializers);
      }
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      properties.add(property.name.text);
      if (property.name.text === 'name') {
        name = resolveStringValue(property.name, initializers);
      }
    }
  }
  return name === null ? null : { name, properties };
}

function importedMigrateUserNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !/^\.\.\/src\/migrate(?:\.(?:ts|js))?$/.test(statement.moduleSpecifier.text)
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (importedName === 'migrateUser') names.add(element.name.text);
    }
  }
  return names;
}

function directTestCallbacks(
  sourceFile: ts.SourceFile,
): Array<ts.ArrowFunction | ts.FunctionExpression> {
  const callbacks: Array<ts.ArrowFunction | ts.FunctionExpression> = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === 'it' || node.expression.text === 'test')
    ) {
      const callback = node.arguments[1];
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        callbacks.push(callback);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return callbacks;
}

/**
 * Prove that the authored suite contains the three requested scenarios and
 * calls the imported production function with its legacy-record input shape.
 * This is syntax/dataflow validation, not keyword counting: bare string calls,
 * prose-only cases, and unrelated dummy calls do not satisfy the gate.
 */
export function evaluateSchemaMigrationTests(text: string | null): SchemaMigrationTestDiagnostics {
  if (text === null) {
    return {
      updated: false,
      testCaseCount: 0,
      validTestCaseCount: 0,
      validLegacyRecordCallCount: 0,
      invalidMigrateUserCallCount: 0,
      coverage: { normalFullName: false, oneWordName: false, multiWordName: false },
      unmet: [
        'migrate-user-import',
        'three-test-cases',
        'legacy-record-arguments',
        'normal-full-name-case',
        'one-word-name-case',
        'multi-word-name-case',
      ],
    };
  }

  const sourceFile = sourceFileFor(text, SCHEMA_MIGRATION_TEST_PATH);
  const migrateUserNames = importedMigrateUserNames(sourceFile);
  const callbacks = directTestCallbacks(sourceFile);
  const globalInitializers = simpleInitializers(sourceFile);
  let validTestCaseCount = 0;
  let validLegacyRecordCallCount = 0;
  let invalidMigrateUserCallCount = 0;
  const requiredLegacyFields = seededPreservedUserFields().map((field) => field.name);
  const coverage = { normalFullName: false, oneWordName: false, multiWordName: false };

  for (const callback of callbacks) {
    const initializers = new Map(globalInitializers);
    for (const [name, initializer] of simpleInitializers(callback.body)) {
      initializers.set(name, initializer);
    }

    let callbackHasValidLegacyRecordCall = false;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        migrateUserNames.has(node.expression.text)
      ) {
        const argument = node.arguments[0];
        const legacyRecord = argument ? legacyRecordFromArgument(argument, initializers) : null;
        const hasFullLegacyRecord =
          legacyRecord !== null &&
          requiredLegacyFields.every((field) => legacyRecord.properties.has(field));
        if (!hasFullLegacyRecord || legacyRecord === null) {
          invalidMigrateUserCallCount += 1;
        } else {
          callbackHasValidLegacyRecordCall = true;
          validLegacyRecordCallCount += 1;
          const parts = legacyRecord.name.trim().split(/\s+/).filter(Boolean);
          if (parts.length === 1) coverage.oneWordName = true;
          if (parts.length === 2) coverage.normalFullName = true;
          if (parts.length >= 3) coverage.multiWordName = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(callback.body);
    if (callbackHasValidLegacyRecordCall) validTestCaseCount += 1;
  }

  const unmet: SchemaMigrationTestSubcontract[] = [];
  if (migrateUserNames.size === 0) unmet.push('migrate-user-import');
  if (callbacks.length < 3) unmet.push('three-test-cases');
  if (validTestCaseCount < 3 || validLegacyRecordCallCount < 3 || invalidMigrateUserCallCount > 0) {
    unmet.push('legacy-record-arguments');
  }
  if (!coverage.normalFullName) unmet.push('normal-full-name-case');
  if (!coverage.oneWordName) unmet.push('one-word-name-case');
  if (!coverage.multiWordName) unmet.push('multi-word-name-case');

  return {
    updated: unmet.length === 0,
    testCaseCount: callbacks.length,
    validTestCaseCount,
    validLegacyRecordCallCount,
    invalidMigrateUserCallCount,
    coverage,
    unmet,
  };
}

const TEST_SUBCONTRACT_DESCRIPTIONS: Record<SchemaMigrationTestSubcontract, string> = {
  'migrate-user-import': 'import the exported migrateUser function from ../src/migrate',
  'three-test-cases': 'define at least three direct test(...) or it(...) cases',
  'legacy-record-arguments':
    'call migrateUser with full seeded legacy records containing id, name, and email',
  'normal-full-name-case': 'cover a two-word name through a full legacy User record',
  'one-word-name-case': 'cover a one-word name through a full legacy User record',
  'multi-word-name-case': 'cover a three-or-more-word name through a full legacy User record',
};

function testSubcontractSummary(diagnostics: SchemaMigrationTestDiagnostics): string {
  return diagnostics.unmet
    .map((subcontract) => `${subcontract} (${TEST_SUBCONTRACT_DESCRIPTIONS[subcontract]})`)
    .join('; ');
}

const HANDLER_SUBCONTRACT_DESCRIPTIONS: Record<SchemaMigrationHandlerSubcontract, string> = {
  'allowed-imports': 'remove unrelated CreateUserInput/UserStore imports',
  'format-display-signature': 'preserve formatDisplayName(user: User): string',
  'format-display-full-name': 'return firstName + space + lastName from formatDisplayName',
  'render-card-signature': 'preserve renderUserCardHtml(user: User): string',
  'render-card-full-name': 'include firstName + space + lastName in the rendered card',
  'render-card-email': 'include the actual user.email in the rendered card',
  'summary-signature': 'preserve summarizeUsersForLog(users: User[]): string',
  'summary-actual-user-id': 'include each mapped user.id in the log entry',
  'summary-full-name': 'include each mapped user firstName + space + lastName',
  'summary-join': 'join the mapped log entries into one string',
  'no-legacy-name-access': 'remove every live .name property access',
};

function handlerSubcontractSummary(diagnostics: SchemaMigrationHandlerDiagnostics): string {
  return diagnostics.unmet
    .map((subcontract) => `${subcontract} (${HANDLER_SUBCONTRACT_DESCRIPTIONS[subcontract]})`)
    .join('; ');
}

function handlerNeedsOnlyImportCleanup(diagnostics: SchemaMigrationHandlerDiagnostics): boolean {
  return (
    diagnostics.bodiesPass &&
    diagnostics.forbiddenImports.length > 0 &&
    diagnostics.unmet.every((subcontract) => subcontract === 'allowed-imports')
  );
}

export function schemaMigrationFeedbackFor(
  signals: readonly string[],
  failReason: string,
  handlerDiagnostics?: SchemaMigrationHandlerDiagnostics,
): { filePath: string; failReason: string } {
  const missing = new Set(SCHEMA_SIGNAL_NAMES.filter((s) => !signals.includes(s)));

  if (missing.has('types-updated')) {
    return {
      filePath: 'src/types.ts',
      failReason: [
        'SCHEMA_TYPES_REPAIR: src/types.ts has not reached the required contract yet.',
        'Rewrite the User interface with id, firstName: string, lastName: string, and email. Rewrite CreateUserInput with firstName: string, lastName: string, and email. Both fields must be required, and neither contract may retain a name property.',
        'Comments describing the old schema are allowed, but they do not count as migrated fields.',
        'Finish this file before repairing its consumers in src/store.ts and src/handlers.ts.',
        `Original checker failure: ${failReason}`,
      ].join(' '),
    };
  }

  if (missing.has('store-updated')) {
    return {
      filePath: 'src/store.ts',
      failReason: [
        'SCHEMA_STORE_REPAIR: src/store.ts still uses the legacy User name shape or is missing live firstName/lastName field usage.',
        'Preserve the seeded public API: keep the exported UserStore class with add(input: CreateUserInput): User, get(id: string): User | undefined, and list(): User[]. Do not rename or replace the class, remove any of these methods, or add parameters to list().',
        'Repair src/store.ts so add(input) constructs User with id, firstName: input.firstName, lastName: input.lastName, and email: input.email. list() must sort by firstName, then lastName, without any .name property access.',
        missing.has('handlers-updated')
          ? 'src/handlers.ts also remains, but finish src/store.ts first; the checker will route the next repair separately.'
          : 'src/handlers.ts is already passing; do not edit it for this failure.',
        `Original checker failure: ${failReason}`,
      ].join(' '),
    };
  }

  if (missing.has('handlers-updated')) {
    if (handlerDiagnostics && handlerNeedsOnlyImportCleanup(handlerDiagnostics)) {
      const names = handlerDiagnostics.forbiddenImports.map((name) => `\`${name}\``).join(', ');
      return {
        filePath: 'src/handlers.ts',
        failReason: [
          'SCHEMA_HANDLER_IMPORT_REPAIR: all three exported handler signatures and bodies already pass every semantic subcontract. Do not rewrite or modify any function body.',
          `The only remaining handler failure is allowed-imports. Delete exactly these forbidden unused imports: ${names}. Preserve the \`User\` import and every other import.`,
          'If a forbidden name shares a named import declaration with `User`, remove only that import specifier. If it has its own import declaration, delete only that declaration.',
          'Make one localized edit with replace_in_file or replace_lines. Do not use write_file, do not reformat the file, and do not add replacement aliases or demo code.',
          `Original checker failure: ${failReason}`,
        ].join(' '),
      };
    }

    const specificFailures = handlerDiagnostics
      ? `Unmet handler subcontracts: ${handlerSubcontractSummary(handlerDiagnostics)}.`
      : 'The checker could not isolate a narrower handler subcontract from this revision.';
    return {
      filePath: 'src/handlers.ts',
      failReason: [
        'handlers.ts still has stale `.name` access or no longer preserves one of the seeded handler behaviors. src/store.ts is already passing; do not edit store.ts for this failure.',
        specificFailures,
        'Preserve the seeded public API in src/handlers.ts: keep formatDisplayName(user: User): string, renderUserCardHtml(user: User): string, and summarizeUsersForLog(users: User[]): string. Do not change those signatures, import CreateUserInput or UserStore, or add a demo/main routine.',
        'Repair every live name call site while preserving the seeded behavior: formatDisplayName uses `user.firstName` + space + `user.lastName`; renderUserCardHtml uses that same full name in the <h3> and still includes `user.email`; summarizeUsersForLog maps each user as the actual `user.id`, a colon, and `firstName lastName`, then joins the entries. A literal `id:` label without reading `user.id` is incorrect.',
        'A one-occurrence replacement is insufficient because the seeded file has multiple `.name` call sites. Make the smallest edit strategy that corrects all three exported functions while preserving their signatures.',
        `Original checker failure: ${failReason}`,
      ].join(' '),
    };
  }

  if (missing.has('migrate-function')) {
    return {
      filePath: 'src/migrate.ts',
      failReason: [
        'SCHEMA_MIGRATE_REPAIR: create or replace src/migrate.ts with an exported migrateUser function.',
        'It must accept the full legacy User record `{ id: string; name: string; email: string }`, split old.name on the first space, and return `{ id: old.id, firstName, lastName, email: old.email }` with no legacy name field.',
        'Preserve every seeded non-name User field from the input; hard-coded replacement values, omitted fields, and `{ ...old }` output that retains name all fail a harness-owned hidden runtime probe. Keeping an old.name read inside this migration function is expected.',
        `Original checker failure: ${failReason}`,
      ].join(' '),
    };
  }

  if (missing.has('tests-present')) {
    return {
      filePath: SCHEMA_MIGRATION_TEST_PATH,
      failReason: [
        'SCHEMA_TESTS_REPAIR: create or repair tests/migrate.test.ts with at least three direct test(...) or it(...) cases for the imported migrateUser function.',
        'Call the exported contract with full legacy record objects, for example `migrateUser({ id, name: value, email })`; a bare string or name-only object is invalid.',
        'Cover a normal two-word name, a one-word name, and a three-or-more-word name. Assert preserved id/email plus the returned firstName/lastName values.',
        'The harness strictly typechecks this exact test file against the current src/migrate.ts using grader-owned compiler settings, even though the project tsconfig excludes tests.',
        `Checker diagnostic: ${failReason}`,
      ].join(' '),
    };
  }

  if (missing.has('migration-doc')) {
    return {
      filePath: 'MIGRATION.md',
      failReason: [
        'SCHEMA_MIGRATION_DOC: source, migration utility, and tests are far enough along; write the missing migration guide now.',
        'Create or replace MIGRATION.md with at least 1 KB describing the schema change, breaking impact, how to migrate full old `{ id, name, email }` records without losing non-name fields, and the firstName/lastName split behavior.',
        'Do not keep editing src/store.ts, src/handlers.ts, src/migrate.ts, or tests for this doc-only failure unless the checker names one of those files again.',
        `Original checker failure: ${failReason}`,
      ].join(' '),
    };
  }

  if (missing.size === 1 && missing.has('tsc-clean')) {
    const targetFile = failReason.match(/^tsc-clean failed:\s+([^(:\s]+\.ts)\(/)?.[1];
    return {
      filePath: targetFile ?? 'src/types.ts',
      failReason: [
        'SCHEMA_TSC_REPAIR: all structural migration signals are present; fix the TypeScript contract only. Do not rewrite docs or tests for this failure.',
        `Compiler failure: ${failReason}`,
        'Final type contract: User has id, firstName, lastName, email. CreateUserInput has firstName, lastName, email. No live code should read or write User.name or input.name.',
        'src/store.ts add(input) returns { id, firstName: input.firstName, lastName: input.lastName, email: input.email }; list() sorts by firstName, then lastName.',
        'src/handlers.ts builds the display name from firstName + space + lastName in every handler.',
        'src/migrate.ts migrateUser(old) defines a legacy input with required id, name, and email, splits old.name into firstName and lastName, preserves old.id/old.email (and every other seeded non-name field), and returns one User object with no name property.',
        'Do not add `name` back to src/types.ts or the exported User/CreateUserInput contracts to silence the compiler.',
        'Read the compiler-named file, then make one targeted edit there. If earlier patching created duplicate properties or a wrong return shape, rewrite that whole file once.',
      ].join(' '),
    };
  }

  return {
    filePath: 'src/types.ts',
    failReason: `SCHEMA_REPAIR: re-check the source contracts starting with src/types.ts. ${failReason}`,
  };
}

function firstTypeScriptError(stdout: string, stderr: string): string {
  return (
    `${stdout}\n${stderr}`
      .split('\n')
      .map((line) => line.trim())
      .find((line) => /error TS\d+:/i.test(line))
      ?.slice(0, 500) ?? 'tsc --noEmit failed without a parsed diagnostic'
  );
}

/**
 * Compile and run the grader-owned migrateUser probe. The candidate controls
 * `src/migrate.ts`, but not the records, expected outputs, or assertions. This
 * is intentionally separate from model-authored Vitest content.
 */
export async function runSchemaMigrationFunctionGateInDir(
  dir: string,
): Promise<SchemaMigrationFunctionGateResult | null> {
  const configPath = join(dir, MIGRATION_GATE_CONFIG_PATH);
  const probePath = join(dir, MIGRATION_GATE_PROBE_PATH);
  const outDir = join(dir, MIGRATION_GATE_OUT_DIR);
  try {
    await Promise.all([
      fsWriteFile(configPath, migrationFunctionGateConfigJson(), 'utf8'),
      fsWriteFile(probePath, migrationFunctionProbeSource(), 'utf8'),
    ]);
    const compile = await spawnAndAwait(
      process.execPath,
      [resolveTscBin(), '--pretty', 'false', '--project', configPath],
      { cwd: dir, timeoutMs: 90_000 },
    );
    if (compile.timedOut) {
      return {
        ok: false,
        stage: 'typecheck',
        exitCode: compile.exitCode,
        firstError: 'harness-owned migrateUser typecheck timed out after 90s',
        timedOut: true,
      };
    }
    if (compile.exitCode === null) return null;
    if (compile.exitCode !== 0) {
      return {
        ok: false,
        stage: 'typecheck',
        exitCode: compile.exitCode,
        firstError: firstTypeScriptError(compile.stdout, compile.stderr),
        timedOut: false,
      };
    }

    // The emitted probe is ESM. Pin its module mode inside the disposable
    // output tree instead of trusting or overwriting the candidate package.
    await fsWriteFile(join(outDir, 'package.json'), '{"type":"module"}\n', 'utf8');
    const emittedProbe = join(outDir, MIGRATION_GATE_PROBE_PATH.replace(/\.ts$/, '.js'));
    const runtime = await spawnAndAwait(process.execPath, ['--no-warnings', emittedProbe], {
      cwd: outDir,
      timeoutMs: 30_000,
    });
    if (runtime.timedOut) {
      return {
        ok: false,
        stage: 'runtime',
        exitCode: runtime.exitCode,
        firstError: 'harness-owned migrateUser runtime probe timed out after 30s',
        timedOut: true,
      };
    }
    if (runtime.exitCode === null) return null;
    const markerLine = runtime.stdout
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith(MIGRATION_GATE_MARKER));
    if (!markerLine) {
      const detail = `${runtime.stderr}\n${runtime.stdout}`.trim().slice(0, 500);
      return {
        ok: false,
        stage: 'runtime',
        exitCode: runtime.exitCode,
        firstError:
          detail ||
          `harness-owned migrateUser runtime exited ${runtime.exitCode} without a result marker`,
        timedOut: false,
      };
    }
    try {
      const parsed = JSON.parse(markerLine.slice(MIGRATION_GATE_MARKER.length)) as {
        ok?: boolean;
        why?: string;
      };
      if (parsed.ok === true) {
        return { ok: true, stage: 'pass', exitCode: 0, timedOut: false };
      }
      return {
        ok: false,
        stage: 'runtime',
        exitCode: runtime.exitCode,
        firstError: parsed.why ?? 'harness-owned migrateUser runtime failed without a reason',
        timedOut: false,
      };
    } catch {
      return {
        ok: false,
        stage: 'runtime',
        exitCode: runtime.exitCode,
        firstError: `invalid harness-owned migrateUser result: ${markerLine.slice(0, 400)}`,
        timedOut: false,
      };
    }
  } catch {
    return null;
  } finally {
    await Promise.all([
      rm(configPath, { force: true }).catch(() => {}),
      rm(probePath, { force: true }).catch(() => {}),
      rm(outDir, { recursive: true, force: true }).catch(() => {}),
    ]);
  }
}

/**
 * Strictly typecheck production source plus the exact generated migration
 * suite. The config and Vitest declaration are written by the grader after
 * materialization, so a candidate cannot exclude tests or relax strictness.
 */
export async function runSchemaMigrationTestTypecheckInDir(
  dir: string,
): Promise<SchemaMigrationTestTypecheckResult | null> {
  const configPath = join(dir, TEST_TSC_CONFIG_PATH);
  const vitestShimPath = join(dir, TEST_VITEST_SHIM_PATH);
  try {
    await Promise.all([
      fsWriteFile(configPath, TEST_TSC_GATE_CONFIG_JSON, 'utf8'),
      fsWriteFile(vitestShimPath, TEST_VITEST_SHIM_TS, 'utf8'),
    ]);
    const result = await spawnAndAwait(
      process.execPath,
      [resolveTscBin(), '--pretty', 'false', '--project', configPath],
      { cwd: dir, timeoutMs: 90_000 },
    );
    if (result.timedOut) {
      return {
        ok: false,
        exitCode: result.exitCode,
        firstError: 'generated-test strict typecheck timed out after 90s',
        timedOut: true,
      };
    }
    if (result.exitCode === null) return null;
    if (result.exitCode === 0) {
      return { ok: true, exitCode: 0, timedOut: false };
    }
    return {
      ok: false,
      exitCode: result.exitCode,
      firstError: firstTypeScriptError(result.stdout, result.stderr),
      timedOut: false,
    };
  } catch {
    return null;
  } finally {
    await Promise.all([
      rm(configPath, { force: true }).catch(() => {}),
      rm(vitestShimPath, { force: true }).catch(() => {}),
    ]);
  }
}

async function runMigrationFunctionGate(
  ctx: EvalContext,
  client: GezelClient,
  projectId: string,
  contentHash: string,
  log: (line: string) => void,
): Promise<SchemaMigrationFunctionGateResult | null> {
  const cached = migrationFunctionRunCache.get(ctx);
  if (cached && cached.lastHash === contentHash) return cached.lastResult;

  const tmp = await mkdtemp(`${tmpdir()}/gezel-eval-schema-migration-function-`);
  try {
    await materializeProjectWorkspace(client, projectId, tmp, {
      include: /\.(?:ts|tsx|mts|cts|json)$/,
    });
    const result = await runSchemaMigrationFunctionGateInDir(tmp);
    if (result === null) {
      log('[scenario] harness-owned migrateUser gate unavailable (harness error)');
      return null;
    }
    log(
      `[scenario] migrateUser gate: ok=${result.ok} stage=${result.stage} exit=${result.exitCode}${
        result.firstError ? ` first="${result.firstError.slice(0, 180)}"` : ''
      }`,
    );
    migrationFunctionRunCache.set(ctx, { lastHash: contentHash, lastResult: result });
    return result;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function runGeneratedTestTypecheck(
  ctx: EvalContext,
  client: GezelClient,
  projectId: string,
  contentHash: string,
  log: (line: string) => void,
): Promise<SchemaMigrationTestTypecheckResult | null> {
  const cached = testTscRunCache.get(ctx);
  if (cached && cached.lastHash === contentHash) return cached.lastResult;

  const tmp = await mkdtemp(`${tmpdir()}/gezel-eval-schema-tests-`);
  try {
    await materializeProjectWorkspace(client, projectId, tmp, {
      include: /\.(?:ts|tsx|mts|cts|json)$/,
    });
    const result = await runSchemaMigrationTestTypecheckInDir(tmp);
    if (result === null) {
      log('[scenario] generated-test strict typecheck unavailable (harness error)');
      return null;
    }
    log(
      `[scenario] generated-test tsc: ok=${result.ok} exit=${result.exitCode}${
        result.firstError ? ` first="${result.firstError.slice(0, 180)}"` : ''
      }`,
    );
    testTscRunCache.set(ctx, { lastHash: contentHash, lastResult: result });
    return result;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function runTsc(
  ctx: EvalContext,
  client: GezelClient,
  projectId: string,
  contentHash: string,
  log: (line: string) => void,
): Promise<{ ok: boolean; firstError?: string }> {
  // Skip the spawn if we already ran tsc against this exact content.
  const cached = tscRunCache.get(ctx);
  if (cached && cached.lastHash === contentHash) {
    return cached.lastResult
      ? { ok: true }
      : { ok: false, firstError: cached.firstError ?? '(cached)' };
  }

  // Materialize the project's workspace files into a temp dir so tsc
  // has a real filesystem to read. We can't tsc against the gezel
  // service's workspace API directly — tsc needs node:fs paths.
  const tmp = await mkdtemp(`${tmpdir()}/gezel-eval-tsc-`);
  try {
    await materializeProjectWorkspace(client, projectId, tmp, {
      include: /\.(?:ts|tsx|mts|cts|json)$/,
    });
    const tsc = resolveTscBin();
    const result = await spawnAndAwait(process.execPath, [tsc, '--noEmit', '-p', tmp], {
      cwd: tmp,
      timeoutMs: 90_000,
    });
    const ok = result.exitCode === 0;
    if (!ok) {
      // Pull the first error line from stdout (tsc writes errors to stdout, not stderr).
      const firstError = firstTypeScriptError(result.stdout, result.stderr).slice(0, 200);
      log(`[scenario] tsc failed: ${firstError}`);
      tscRunCache.set(ctx, { lastHash: contentHash, lastResult: false, firstError });
      return { ok: false, firstError };
    }
    log(`[scenario] tsc passed (${result.durationMs} ms)`);
    tscRunCache.set(ctx, { lastHash: contentHash, lastResult: true });
    return { ok: true };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

export const schemaMigrationScenario: EvalScenario = {
  id: 'schema-migration',
  description:
    'Multi-file TypeScript refactor: split User.name into firstName/lastName across types.ts, store.ts, handlers.ts; write a full-record-preserving migrateUser, vitest tests, and MIGRATION.md; pass the hidden migration runtime and `tsc --noEmit` gates.',
  prompt: [
    `Heads up: ${DEVELOPER_NAME} is doing a multi-file TypeScript migration on the`,
    `"${PROJECT_NAME}" project. The brief, missionObjectives, and seed files are all`,
    "in that project. You don't need to do anything — just confirm you've seen this note.",
  ].join(' '),
  // 35 min: ~5 file reads + 6 file writes + 1-3 tsc retries. Local
  // 30-120B models should fit; gemma4-e4b will likely struggle on
  // multi-file coordination.
  timeoutMs: 35 * 60_000,
  // Near-ceiling on mid-size models (passes for nearly every
  // family incl. qwen3.5-2b) — run as a 1-trial regression canary in
  // matrices; `failing-tests-spec` is the headroom successor.
  suggestedTrials: 1,
  // The model spends a lot of time reading + reasoning between writes.
  // 15 min between progress events leaves headroom for super-120b-class
  // models whose first-turn warmup + thinking exceeds 7 min; smaller
  // models (gemma/qwen/nano) deliver turns well under this ceiling so
  // the larger window is super-only headroom.
  progressTimeoutMs: 15 * 60_000,
  setup,
  skipInitialPrompt: true,
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const { client, log, logChanged, recordSniff } = ctx;
    const projectId = await findProjectId(client);
    if (!projectId) {
      logChanged('project', '[scenario] user-store project not present yet');
      return { done: false };
    }

    // Read the candidate target files (some may not exist yet).
    const [typesTs, storeTs, handlersTs, migrateTs, testFile, migrationMd] = await Promise.all([
      readWorkspaceText(client, projectId, 'src/types.ts'),
      readWorkspaceText(client, projectId, 'src/store.ts'),
      readWorkspaceText(client, projectId, 'src/handlers.ts'),
      readWorkspaceText(client, projectId, 'src/migrate.ts'),
      readWorkspaceText(client, projectId, SCHEMA_MIGRATION_TEST_PATH),
      readWorkspaceText(client, projectId, 'MIGRATION.md'),
    ]);

    const signals: string[] = [];
    const failures: string[] = [];

    // Structural sniffs — fast, no spawn needed. Parse TypeScript syntax so
    // comments and string literals cannot satisfy field requirements or look
    // like stale property access.
    const structure = evaluateSchemaMigrationStructure({ typesTs, storeTs, handlersTs });
    const handlerDiagnostics = evaluateSchemaMigrationHandlers(handlersTs);

    if (structure.typesUpdated) signals.push('types-updated');
    else if (typesTs !== null)
      failures.push(
        'types.ts still declares name or is missing required string firstName/lastName fields on User and CreateUserInput',
      );

    if (structure.storeUpdated) signals.push('store-updated');
    else if (storeTs !== null)
      failures.push('store.ts still uses a live name property or is missing firstName/lastName');

    if (structure.handlersUpdated) signals.push('handlers-updated');
    else if (handlersTs !== null) {
      failures.push(
        `handlers.ts unmet subcontracts: ${handlerSubcontractSummary(handlerDiagnostics)}`,
      );
    }

    const migrateFunctionSyntaxReady =
      migrateTs !== null &&
      /export\s+(?:function|const)\s+migrateUser\b/.test(migrateTs) &&
      // Accept any string-splitting strategy: `.split(' ')`, or `.slice()`
      // paired with `.indexOf(' ')` / `.indexOf(" ")`, or `.substring`
      // with the same lookup. Wild-caught qwen3.6 trial: model
      // wrote a correct slice+indexOf implementation; the literal `.split`
      // requirement falsely flagged it as missing the split logic.
      (/\.split\s*\(/.test(migrateTs) ||
        (/\.(?:slice|substring|substr)\s*\(/.test(migrateTs) && /\.indexOf\s*\(/.test(migrateTs)));
    let migrateFunctionReady = false;
    let migrationFunctionGateUnavailable = false;
    let migrationFunctionGate: SchemaMigrationFunctionGateResult | null = null;
    if (migrateFunctionSyntaxReady && structure.typesUpdated) {
      const migrationFunctionHash = JSON.stringify([typesTs, migrateTs]);
      migrationFunctionGate = await runMigrationFunctionGate(
        ctx,
        client,
        projectId,
        migrationFunctionHash,
        log,
      );
      if (migrationFunctionGate === null) migrationFunctionGateUnavailable = true;
      else migrateFunctionReady = migrationFunctionGate.ok;
    }
    if (migrateFunctionReady) {
      signals.push('migrate-function');
    } else if (migrateTs !== null) {
      if (!migrateFunctionSyntaxReady) {
        failures.push(
          'migrate.ts exists but does not export `migrateUser` with a string-splitting implementation (looking for .split, or .slice/.substring + .indexOf)',
        );
      } else if (structure.typesUpdated) {
        if (migrationFunctionGate === null) {
          failures.push('migrate.ts harness-owned preservation gate temporarily unavailable');
        } else {
          failures.push(
            `migrate.ts harness-owned preservation gate failed at ${migrationFunctionGate.stage}: ${migrationFunctionGate.firstError ?? 'unknown migration behavior failure'}`,
          );
        }
      }
    }

    const testDiagnostics = evaluateSchemaMigrationTests(testFile);
    const sourceReadyForTestTypecheck =
      structure.typesUpdated &&
      structure.storeUpdated &&
      structure.handlersUpdated &&
      migrateFunctionReady;
    let testTypecheckUnavailable = false;
    let testTypecheck: SchemaMigrationTestTypecheckResult | null = null;
    if (testFile !== null && sourceReadyForTestTypecheck) {
      const testTypecheckHash = JSON.stringify([typesTs, storeTs, handlersTs, migrateTs, testFile]);
      testTypecheck = await runGeneratedTestTypecheck(
        ctx,
        client,
        projectId,
        testTypecheckHash,
        log,
      );
    }

    if (testFile === null) {
      failures.push(`${SCHEMA_MIGRATION_TEST_PATH} not present yet`);
    } else {
      const testFailures: string[] = [];
      if (!testDiagnostics.updated) {
        testFailures.push(
          `unmet subcontracts: ${testSubcontractSummary(testDiagnostics)} ` +
            `(direct cases=${testDiagnostics.testCaseCount}, valid cases=${testDiagnostics.validTestCaseCount}, valid legacy-record calls=${testDiagnostics.validLegacyRecordCallCount}, invalid migrateUser calls=${testDiagnostics.invalidMigrateUserCallCount})`,
        );
      }
      if (sourceReadyForTestTypecheck) {
        if (testTypecheck === null) {
          if (testDiagnostics.updated) testTypecheckUnavailable = true;
        } else if (!testTypecheck.ok) {
          testFailures.push(
            `strict generated-test typecheck failed: ${testTypecheck.firstError ?? 'unknown TypeScript error'}`,
          );
        }
      }
      if (testDiagnostics.updated && testTypecheck?.ok) {
        signals.push('tests-present');
      } else if (testFailures.length > 0) {
        failures.push(`${SCHEMA_MIGRATION_TEST_PATH} ${testFailures.join(' | ')}`);
      } else if (testTypecheckUnavailable) {
        failures.push(`${SCHEMA_MIGRATION_TEST_PATH} strict typecheck temporarily unavailable`);
      }
    }

    if (migrationMd !== null && migrationMd.length >= 1024) {
      const keywords = ['breaking', 'migrate', 'firstName', 'split'].filter((kw) =>
        migrationMd.toLowerCase().includes(kw.toLowerCase()),
      );
      if (keywords.length >= 2) signals.push('migration-doc');
      else
        failures.push(
          `MIGRATION.md is ≥ 1 KB but only mentions ${keywords.length} of the 4 expected keywords`,
        );
    } else if (migrationMd !== null) {
      failures.push(`MIGRATION.md is only ${migrationMd.length} bytes (need ≥ 1024)`);
    } else {
      failures.push('MIGRATION.md not present yet');
    }

    // Tsc-clean gate — only run after all 6 structural signals fire,
    // since tsc is expensive (~3-8 s per spawn).
    const structuralComplete =
      signals.includes('types-updated') &&
      signals.includes('store-updated') &&
      signals.includes('handlers-updated') &&
      signals.includes('migrate-function') &&
      signals.includes('tests-present') &&
      signals.includes('migration-doc');

    let tscOk = false;
    if (structuralComplete) {
      // Use the source contents themselves as the cache key. Lengths alone can
      // collide when a repair replaces one field with another of equal length,
      // which would otherwise replay a stale compiler result.
      const contentHash = JSON.stringify([typesTs, storeTs, handlersTs, migrateTs]);
      const tsc = await runTsc(ctx, client, projectId, contentHash, log);
      tscOk = tsc.ok;
      if (tscOk) signals.push('tsc-clean');
      else if (tsc.firstError) failures.push(`tsc-clean failed: ${tsc.firstError}`);
    }

    const totalBytes =
      (typesTs?.length ?? 0) +
      (storeTs?.length ?? 0) +
      (handlersTs?.length ?? 0) +
      (migrateTs?.length ?? 0) +
      (testFile?.length ?? 0) +
      (migrationMd?.length ?? 0);
    const score = signals.length;
    const failReason = failures.length > 0 ? failures[0] : undefined;
    const feedback =
      failReason && !testTypecheckUnavailable && !migrationFunctionGateUnavailable
        ? schemaMigrationFeedbackFor(signals, failReason, handlerDiagnostics)
        : undefined;

    logChanged(
      'sniff',
      `[scenario] schema-migration bytes=${totalBytes} score=${score}/7 signals=${signals.join(',') || 'none'}${failReason ? ` failReason="${failReason}"` : ''}`,
    );
    recordSniff?.({
      key: 'schema-migration',
      score,
      bytes: totalBytes,
      failReason,
      ...(feedback ? { repairFilePath: feedback.filePath } : {}),
    });

    if (tscOk && score >= 7) {
      return {
        done: true,
        success: true,
        reason: `all 7 signals firing including tsc-clean (signals: ${signals.join(', ')})`,
      };
    }

    // Forward the structural / tsc failure into the team chat so the
    // model has something to act on. Without this the model iterates
    // blindly while the trial log records the failure. Unchanged polls
    // dedupe, while a changed selected file that still misses the same
    // gate advances postSniffFeedback's bounded escalation ladder.
    if (feedback) {
      const missing = SCHEMA_SIGNAL_NAMES.filter((s) => !signals.includes(s));
      const sourceTextByPath = new Map<string, string | null>([
        ['src/types.ts', typesTs],
        ['src/store.ts', storeTs],
        ['src/handlers.ts', handlersTs],
        ['src/migrate.ts', migrateTs],
        [SCHEMA_MIGRATION_TEST_PATH, testFile],
        ['MIGRATION.md', migrationMd],
      ]);
      const selectedSourceText = sourceTextByPath.has(feedback.filePath)
        ? sourceTextByPath.get(feedback.filePath)
        : await readWorkspaceText(client, projectId, feedback.filePath);
      await postSniffFeedback(
        ctx,
        feedback.filePath,
        {
          ok: false,
          signals,
          score,
          failReason,
          missingRequiredSignals: missing,
        },
        {
          sourceText: selectedSourceText ?? '',
          repairDirective: feedback.failReason,
          targetedEditsOnly:
            feedback.filePath === 'src/handlers.ts' &&
            handlerNeedsOnlyImportCleanup(handlerDiagnostics),
        },
      );
    }
    return { done: false };
  },
};
