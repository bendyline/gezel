import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type GetScriptSourceResponse,
  type ScriptDiagnostic,
  ScriptNameSchema,
  type ScriptProvenance,
  type ScriptTemplateId,
} from '@bendyline/gezel';
import { projectScriptFile, userScriptFile, userScriptsDir } from '@bendyline/gezel/paths';
import ts from 'typescript';
import { writeFileAtomic } from '../fs/atomic.js';
import { craftbookScriptProvenance, generatedScriptProvenance } from './install.js';
import { ScriptMetaError, parseScriptMeta } from './meta.js';

/**
 * Raw script source access for the in-app editor. Deliberately separate
 * from `catalog.ts`: the list endpoint hides scripts whose meta fails to
 * parse, but the editor must be able to open a broken script to fix it,
 * so everything here works on the file bytes first and treats meta as
 * best-effort decoration.
 */

export function scriptSourceHash(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

/**
 * The single fence between user-supplied names and the filesystem: every
 * exported function validates through this before building a path.
 */
function checkedScriptFile(home: string, projectId: string, name: string): string {
  ScriptNameSchema.parse(name);
  return projectScriptFile(home, projectId, name);
}

function parseProvenance(source: string): ScriptProvenance | undefined {
  const craftbook = craftbookScriptProvenance(source);
  if (craftbook) return { kind: 'craftbook', ref: craftbook };
  const imported = generatedScriptProvenance(source);
  if (imported) return { kind: 'import', ref: imported };
  return undefined;
}

export async function readScriptSource(
  home: string,
  projectId: string,
  name: string,
): Promise<GetScriptSourceResponse | null> {
  const file = checkedScriptFile(home, projectId, name);
  let source: string;
  let mtimeMs: number;
  try {
    source = await readFile(file, 'utf8');
    mtimeMs = (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
  const out: GetScriptSourceResponse = {
    name,
    source,
    hash: scriptSourceHash(source),
    mtimeMs,
  };
  try {
    out.meta = parseScriptMeta(source, file);
  } catch (err) {
    out.metaError = err instanceof Error ? err.message : String(err);
  }
  const provenance = parseProvenance(source);
  if (provenance) out.provenance = provenance;
  return out;
}

export async function writeScriptSource(
  home: string,
  projectId: string,
  name: string,
  source: string,
): Promise<{ hash: string }> {
  const file = checkedScriptFile(home, projectId, name);
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, source);
  return { hash: scriptSourceHash(source) };
}

export async function scriptSourceExists(
  home: string,
  projectId: string,
  name: string,
): Promise<boolean> {
  const file = checkedScriptFile(home, projectId, name);
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export async function deleteScriptSource(
  home: string,
  projectId: string,
  name: string,
): Promise<boolean> {
  const file = checkedScriptFile(home, projectId, name);
  try {
    await unlink(file);
    return true;
  } catch {
    return false;
  }
}

/* ───────────────────── User-scope library (~/.gezel/scripts) ────────────── */

function checkedUserScriptFile(home: string, name: string): string {
  ScriptNameSchema.parse(name);
  return userScriptFile(home, name);
}

export async function listUserScripts(
  home: string,
): Promise<Array<{ name: string; meta: import('@bendyline/gezel').ScriptMeta; path: string }>> {
  const { readdir } = await import('node:fs/promises');
  let entries: string[];
  try {
    entries = await readdir(userScriptsDir(home));
  } catch {
    return [];
  }
  const out: Array<{ name: string; meta: import('@bendyline/gezel').ScriptMeta; path: string }> =
    [];
  for (const entry of entries) {
    if (!entry.endsWith('.ts')) continue;
    const name = entry.slice(0, -3);
    const path = userScriptFile(home, name);
    try {
      out.push({ name, meta: parseScriptMeta(await readFile(path, 'utf8'), path), path });
    } catch {
      /* unparseable meta — hidden from the list, still readable below */
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function readUserScriptSource(
  home: string,
  name: string,
): Promise<GetScriptSourceResponse | null> {
  const file = checkedUserScriptFile(home, name);
  let source: string;
  let mtimeMs: number;
  try {
    source = await readFile(file, 'utf8');
    mtimeMs = (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
  const out: GetScriptSourceResponse = {
    name,
    source,
    hash: scriptSourceHash(source),
    mtimeMs,
    provenance: { kind: 'user', ref: name },
  };
  try {
    out.meta = parseScriptMeta(source, file);
  } catch (err) {
    out.metaError = err instanceof Error ? err.message : String(err);
  }
  return out;
}

export async function writeUserScriptSource(
  home: string,
  name: string,
  source: string,
): Promise<{ hash: string }> {
  const file = checkedUserScriptFile(home, name);
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, source);
  return { hash: scriptSourceHash(source) };
}

export async function deleteUserScriptSource(home: string, name: string): Promise<boolean> {
  const file = checkedUserScriptFile(home, name);
  try {
    await unlink(file);
    return true;
  } catch {
    return false;
  }
}

/* ────────────────────────────── Diagnostics ─────────────────────────────── */

/**
 * Save-time validation, three layers:
 *
 *  1. `meta`           — the extractor that the list endpoint and runner
 *                        use; failure means the script is hidden + unrunnable.
 *  2. `typescript`     — syntax errors from the TS parser. Semantic checking
 *                        stays in the editor (Monaco); the service only
 *                        guarantees the file will parse.
 *  3. `runtime-compat` — constructs Node's type-stripping rejects at run
 *                        time (scripts execute via `--experimental-strip-types`,
 *                        see sandbox/runner.ts): enums, namespaces with
 *                        runtime code, constructor parameter properties,
 *                        `import =` / `export =`. Monaco's bundled TS
 *                        doesn't know the flag, so the save path is where
 *                        users find out — before the step hook does.
 */
export function computeScriptDiagnostics(
  source: string,
  scriptPath: string,
  name?: string,
): ScriptDiagnostic[] {
  const diagnostics: ScriptDiagnostic[] = [];

  let meta: ReturnType<typeof parseScriptMeta> | null = null;
  try {
    meta = parseScriptMeta(source, scriptPath);
  } catch (err) {
    diagnostics.push({
      severity: 'error',
      source: 'meta',
      message: err instanceof ScriptMetaError ? err.message : String(err),
    });
  }
  if (meta && name && meta.name !== name) {
    diagnostics.push({
      severity: 'warning',
      source: 'meta',
      message: `meta.name is "${meta.name}" but the file is "${name}.ts" — lists and step hooks always use the file name.`,
    });
  }

  const sf = ts.createSourceFile(scriptPath, source, ts.ScriptTarget.ES2022, true);

  const syntax = ts.transpileModule(source, {
    reportDiagnostics: true,
    fileName: scriptPath,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).diagnostics;
  for (const d of syntax ?? []) {
    diagnostics.push({
      severity: d.category === ts.DiagnosticCategory.Warning ? 'warning' : 'error',
      source: 'typescript',
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      ...positionOf(d.file ?? sf, d.start),
    });
  }

  walkErasableSyntax(sf, sf, diagnostics);
  walkSandboxHostileImports(sf, diagnostics);
  return diagnostics;
}

/**
 * Raw-`fs` imports are the "silently wrong" class for gezel scripts:
 * the import itself succeeds (Node builtins can't be permission-blocked),
 * but the script executes in an empty scratch directory — so reads of
 * workspace deliverables ENOENT *always*, and a gate script built on
 * `existsSync`/`readFileSync` rejects forever while the deliverable sits
 * right there in the workspace (wild-caught on the craftbook format A/B:
 * the model's gate imported `fs` and could never see the report it was
 * judging). Erroring at save time with the correct surface named turns
 * an unexplainable infinite gate loop into a one-shot repair.
 * (`path` stays allowed — pure string ops, no I/O.)
 */
const SANDBOX_HOSTILE_IMPORTS = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);

function walkSandboxHostileImports(sf: ts.SourceFile, out: ScriptDiagnostic[]): void {
  const visit = (node: ts.Node): void => {
    let specifier: ts.Expression | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier;
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      specifier = node.arguments[0];
    }
    if (specifier && ts.isStringLiteralLike(specifier)) {
      if (SANDBOX_HOSTILE_IMPORTS.has(specifier.text)) {
        out.push({
          severity: 'error',
          source: 'runtime-compat',
          message: `import from '${specifier.text}' cannot work here: gezel scripts run in an isolated scratch directory, so raw fs never sees the project workspace (reads ENOENT, writes are denied). Read/write deliverables with the gezel API instead — \`gezel.fs.read(...)\` / \`gezel.fs.write(...)\`, or \`workspaceFromGezel(gezel)\` from '@bendyline/gezel-sdk/checks' for gate checks.`,
          ...positionOf(sf, specifier.getStart(sf)),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

export interface CraftbookScriptValidation {
  name: string;
  diagnostics: ScriptDiagnostic[];
}

/**
 * Save-time validation for a craftbook's inline `scripts` map (name →
 * source). Reuses the exact three-layer pipeline the script editor's save
 * endpoint runs (`computeScriptDiagnostics`), plus one map-specific rule:
 * `meta.name` must EQUAL the map key — the key is the resolution name a
 * step ref uses, so a mismatch means the ref would run a script whose
 * meta says it is something else. That mismatch is an error here (the
 * editor's file-based path keeps it a warning).
 */
export function validateCraftbookScripts(
  scripts: Record<string, string>,
): CraftbookScriptValidation[] {
  const out: CraftbookScriptValidation[] = [];
  for (const [name, source] of Object.entries(scripts)) {
    const file = `${name}.ts`;
    const diagnostics = computeScriptDiagnostics(source, file);
    try {
      const meta = parseScriptMeta(source, file);
      if (meta.name !== name) {
        diagnostics.push({
          severity: 'error',
          source: 'meta',
          message: `meta.name is "${meta.name}" but the scripts map key is "${name}" — they must match (step refs resolve by the map key)`,
        });
      }
    } catch {
      /* already surfaced as a meta diagnostic by computeScriptDiagnostics */
    }
    out.push({ name, diagnostics });
  }
  return out;
}

/** The error-severity subset of {@link validateCraftbookScripts}, formatted for a 4xx payload. */
export function craftbookScriptErrors(scripts: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const v of validateCraftbookScripts(scripts)) {
    for (const d of v.diagnostics) {
      if (d.severity !== 'error') continue;
      const at =
        d.line !== undefined
          ? ` (line ${d.line}${d.column !== undefined ? `:${d.column}` : ''})`
          : '';
      problems.push(`script "${v.name}"${at}: ${d.message}`);
    }
  }
  return problems;
}

function positionOf(
  sf: ts.SourceFile,
  start: number | undefined,
): { line?: number; column?: number } {
  if (start === undefined) return {};
  const pos = sf.getLineAndCharacterOfPosition(start);
  return { line: pos.line + 1, column: pos.character + 1 };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return !!(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === kind));
}

/** Mirrors TS 5.8's `erasableSyntaxOnly` / Node strip-types rejections. */
function walkErasableSyntax(node: ts.Node, sf: ts.SourceFile, out: ScriptDiagnostic[]): void {
  if (ts.isEnumDeclaration(node) && !hasModifier(node, ts.SyntaxKind.DeclareKeyword)) {
    out.push(
      compatError(
        sf,
        node,
        'enums are not supported — use a union of string literals or a plain object instead',
      ),
    );
  } else if (
    ts.isModuleDeclaration(node) &&
    !hasModifier(node, ts.SyntaxKind.DeclareKeyword) &&
    ts.isIdentifier(node.name) &&
    namespaceHasRuntimeCode(node)
  ) {
    out.push(
      compatError(
        sf,
        node,
        'namespaces with runtime code are not supported — use plain top-level declarations',
      ),
    );
  } else if (ts.isImportEqualsDeclaration(node)) {
    out.push(
      compatError(
        sf,
        node,
        '`import x = require(...)` is not supported — use a standard `import` statement',
      ),
    );
  } else if (ts.isExportAssignment(node) && node.isExportEquals) {
    out.push(compatError(sf, node, '`export =` is not supported — use named or default exports'));
  } else if (ts.isConstructorDeclaration(node)) {
    for (const param of node.parameters) {
      if (
        ts
          .getModifiers(param)
          ?.some(
            (m) =>
              m.kind === ts.SyntaxKind.PublicKeyword ||
              m.kind === ts.SyntaxKind.PrivateKeyword ||
              m.kind === ts.SyntaxKind.ProtectedKeyword ||
              m.kind === ts.SyntaxKind.ReadonlyKeyword,
          )
      ) {
        out.push(
          compatError(
            sf,
            param,
            'constructor parameter properties are not supported — declare the field and assign it in the constructor body',
          ),
        );
      }
    }
  }
  ts.forEachChild(node, (child) => walkErasableSyntax(child, sf, out));
}

function namespaceHasRuntimeCode(node: ts.ModuleDeclaration): boolean {
  const body = node.body;
  if (!body || !ts.isModuleBlock(body)) return false;
  return body.statements.some((stmt) => {
    if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) return false;
    if (ts.isModuleDeclaration(stmt)) return namespaceHasRuntimeCode(stmt);
    return true;
  });
}

function compatError(sf: ts.SourceFile, node: ts.Node, message: string): ScriptDiagnostic {
  return {
    severity: 'error',
    source: 'runtime-compat',
    message: `${message} (scripts run with Node type-stripping, which only erases types)`,
    ...positionOf(sf, node.getStart(sf)),
  };
}

/* ─────────────────────────────── Scaffolds ──────────────────────────────── */

/** Escape a value for interpolation inside a single-quoted TS string. */
function q(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
}

/**
 * Starter sources for the New-script dialog. Each is a complete,
 * runnable script whose comments teach the SDK — these are most users'
 * first contact with `gezel.*`, so the comments explain the why, not
 * just the call.
 */
export function scaffoldScript(
  name: string,
  description: string | undefined,
  template: ScriptTemplateId = 'blank',
): string {
  const desc = q(
    description && description.trim().length >= 10
      ? description.trim()
      : `Describe what ${name} does for teammates browsing the script list.`,
  );
  switch (template) {
    case 'post-message':
      return `import { defineScript, gezel, type InferredInput } from '@bendyline/gezel-sdk';

export const meta = defineScript({
  name: '${q(name)}',
  description: '${desc}',
  inputs: {
    taskRef: { type: 'string', description: 'Task to post to, as "projectId/num".', required: true },
    message: { type: 'string', description: 'The note to post.', required: true, multiline: true },
  },
  outputs: {
    posted: { type: 'boolean', description: 'Whether the note was written.' },
  },
  // Scripts can only touch what they declare here. This one writes task
  // notes, so it needs the tasks.write capability.
  requires: ['tasks.write'],
});

const input = gezel.input as InferredInput<typeof meta>;

// Notes land on the task's active phase and show up in the task view.
await gezel.task.writeNotes(input.taskRef, input.message);
gezel.log('posted note to', input.taskRef);

// Every script stamps exactly one output. Step hooks can branch on it.
gezel.output({ posted: true });
`;
    case 'fetch-and-summarize':
      return `import { defineScript, gezel, type InferredInput } from '@bendyline/gezel-sdk';

export const meta = defineScript({
  name: '${q(name)}',
  description: '${desc}',
  inputs: {
    url: { type: 'string', description: 'Page to fetch and summarize.', required: true },
  },
  outputs: {
    summary: { type: 'string', description: 'One-paragraph summary of the page.' },
    chars: { type: 'number', description: 'Length of the fetched page in characters.' },
  },
  // fetch_url needs the network; oneShot needs the llm capability.
  requires: ['network', 'llm'],
});

const input = gezel.input as InferredInput<typeof meta>;

// gezel.mcp.call reaches any registered tool — fetch_url returns the
// page as readable text.
const page = await gezel.mcp.call('fetch_url', { url: input.url });
const text = typeof page === 'string' ? page : JSON.stringify(page);

const summary = await gezel.llm.oneShot(
  \`Summarize the following page in one tight paragraph:\\n\\n\${text.slice(0, 12_000)}\`,
);

gezel.output({ summary, chars: text.length });
`;
    case 'check-files':
      return `import { defineScript, gezel, type InferredInput } from '@bendyline/gezel-sdk';

export const meta = defineScript({
  name: '${q(name)}',
  description: '${desc}',
  inputs: {
    path: { type: 'string', description: 'Workspace folder to inspect.', default: '.' },
  },
  outputs: {
    count: { type: 'number', description: 'Number of entries in the folder.' },
    hasReadme: { type: 'boolean', description: 'Whether a README exists.' },
  },
  requires: ['workspace.read'],
});

const input = gezel.input as InferredInput<typeof meta>;

// Paths are relative to the project workspace; reads outside it are
// blocked by the sandbox.
const entries = await gezel.fs.list(input.path ?? '.');
const hasReadme = entries.some((e) => /^readme(\\.|$)/i.test(e.name));
gezel.log(\`\${entries.length} entries, README: \${hasReadme}\`);

// A step hook can auto-advance on this output — e.g. "move on when
// hasReadme is true" — so checks like this can gate a phase.
gezel.output({ count: entries.length, hasReadme });
`;
    case 'call-tool':
      return `import { defineScript, gezel, type InferredInput } from '@bendyline/gezel-sdk';

export const meta = defineScript({
  name: '${q(name)}',
  description: '${desc}',
  inputs: {
    query: { type: 'string', description: 'What to search for.', required: true },
  },
  outputs: {
    found: { type: 'boolean', description: 'Whether the search returned anything.' },
    top: { type: 'string', description: 'First result, as text.', nullable: true },
  },
  requires: ['network'],
});

const input = gezel.input as InferredInput<typeof meta>;

// Any tool a gezel can use, a script can call — web_search, run_git,
// github_pr_view, run_playwright_script, … (see the tool inventory).
const result = await gezel.mcp.call('web_search', { query: input.query });
const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
gezel.log('search returned', text.length, 'chars');

const top = text.split('\\n').find((line) => line.trim().length > 0) ?? null;
gezel.output({ found: top !== null, top });
`;
    case 'ask-ai':
      return `import { defineScript, gezel, type InferredInput } from '@bendyline/gezel-sdk';

export const meta = defineScript({
  name: '${q(name)}',
  description: '${desc}',
  inputs: {
    taskRef: { type: 'string', description: 'Task to look at, as "projectId/num".', required: true },
    question: { type: 'string', description: 'What to ask about the task.', required: true },
  },
  outputs: {
    answer: { type: 'string', description: 'The model\\'s answer.' },
  },
  requires: ['llm', 'tasks.read'],
});

const input = gezel.input as InferredInput<typeof meta>;

const task = await gezel.task.get(input.taskRef);

const answer = await gezel.llm.oneShot(
  \`You are looking at this task:\\n\${JSON.stringify(task, null, 2)}\\n\\nQuestion: \${input.question}\\nAnswer concisely.\`,
);

gezel.output({ answer });
`;
    default:
      return `import { defineScript, gezel, type InferredInput } from '@bendyline/gezel-sdk';

// Every script exports a meta block: it names the script, declares what
// it takes and produces, and lists the capabilities it may use. The
// service enforces the capability list at call time.
export const meta = defineScript({
  name: '${q(name)}',
  description: '${desc}',
  inputs: {
    example: { type: 'string', description: 'Example input — replace or remove.', default: 'hello' },
  },
  outputs: {
    ok: { type: 'boolean', description: 'Whether the script succeeded.' },
  },
  requires: [],
});

// gezel.input is the validated input; this cast gives it the exact type
// inferred from the meta block above.
const input = gezel.input as InferredInput<typeof meta>;

gezel.log('running with', input.example);

// Every script stamps exactly one output before it finishes.
gezel.output({ ok: true });
`;
  }
}
