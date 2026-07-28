import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import type { GezelClient } from '@bendyline/gezel-client/node';
import type { RuntimeReport } from '../html-validation.ts';
import { extractInlineScripts, validateScriptSyntax } from '../html-validation.ts';
import { postRuntimeFeedback } from '../runtime-feedback.ts';
import { postMissingDeliverableFeedback, postSniffFeedback } from '../sniff-feedback.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import { materializeProjectWorkspace, spawnAndAwait } from './helpers.ts';

/**
 * Codebase Evolution — phased changes against the same small app.
 *
 * This scenario differs from `redline-revision`: it does not just stack
 * requirements in one file. It explicitly measures whether the same
 * developer can build an app, keep extending the existing codebase, and
 * then refactor a monolithic HTML file into multiple JS modules without
 * dropping prior features.
 */

const PROJECT_NAME = 'Launch Board';
const DEVELOPER_NAME = 'Nora';

export const INDEX_PATH = 'index.html';
export const STATE_PATH = 'src/state.js';
export const RENDER_PATH = 'src/render.js';
export const APP_PATH = 'src/app.js';
export const MODULE_PATHS = [STATE_PATH, RENDER_PATH, APP_PATH] as const;
export const RENDERED_TASK_SELECTOR =
  '.task, .task-card, .card, [data-task], [data-id], li, article';

export type CodebasePhase = 1 | 2 | 3 | 4;

export const PHASE_1_MESSAGE = [
  'Phase 1: build the first version of the Launch Board app at `index.html`.',
  'Keep this first version monolithic: HTML, CSS, and inline JavaScript in that one file; do not create `src/` files yet.',
  'It should be a small offline kanban board for launch tasks with Backlog, Doing, and Done sections.',
  'Include a form/input to add tasks, at least three seed tasks, rendering logic, and localStorage persistence.',
  'Use workspace `write_file` paths relative to the workspace root.',
].join(' ');

export const PHASE_2_MESSAGE = [
  'Phase 2: modify the existing Launch Board codebase, do not start over.',
  'Your next assistant action should be a workspace `replace_in_file` or `write_file` edit for `index.html`, not a chat-only plan.',
  'Add task priority support: each task can be Low, Medium, or High priority, the add-task form lets the user choose priority, and the UI can filter by priority.',
  'Make it concrete in this edit: add a `priority` field to each seeded task and to newly added tasks, add a visible priority select/input in the add-task form, add a visible priority filter, and apply that filter in the render loop.',
  'Preserve the Phase 1 board, status columns, seeded tasks, rendering, and localStorage behavior.',
].join(' ');

export const PHASE_3_MESSAGE = [
  'Phase 3: continue evolving the same Launch Board codebase.',
  'Your next assistant action should be a workspace `write_file` edit for `index.html`, not a chat-only plan.',
  'Priority is already done; do not keep revising priority controls unless the edit also adds due-date state, controls, rendering, and summary counts.',
  'Add due dates to tasks and a small summary area with Overdue, Today, and Upcoming counts.',
  'The add-task form should include a date input, rendered tasks should show their due date, and the summary should be computed from task due dates.',
  'Make it concrete in this edit: add a `dueDate` field to each seeded task and to newly added tasks, add a visible `<input type="date" id="dueDateInput" name="dueDate">` in the add-task form, render each task due date, add visible `Overdue`, `Today`, and `Upcoming` summary counts, and compute those buckets with `new Date(task.dueDate)` logic.',
  'Before you finish, the saved `index.html` must literally contain `id="dueDateInput"`, `dueDate`, `Overdue`, `Today`, `Upcoming`, and `new Date(task.dueDate`.',
  'Preserve the priority filter and all earlier board behavior.',
].join(' ');

export const PHASE_4_MESSAGE = [
  'Phase 4: refactor the existing Launch Board codebase without changing the app behavior.',
  'Split the monolithic inline JavaScript out of `index.html` into well-factored ES module files under `src/`.',
  'Create at least `src/state.js`, `src/render.js`, and `src/app.js`.',
  '`index.html` should load `src/app.js` with `<script type="module" src="./src/app.js"></script>` and should no longer contain the app logic inline.',
  'Keep the Launch Board title, Backlog/Doing/Done board, localStorage persistence, priority filtering, due-date input, and Overdue/Today/Upcoming summary working.',
].join(' ');

export const CODEBASE_EVOLUTION_MISSION = [
  'The user will ask for a Launch Board app in four phases.',
  'Do only the current phase when it is sent, then wait for the next request.',
  'The final result must preserve all earlier behavior while refactoring the codebase into ES modules.',
].join(' ');

export interface CodebaseFiles {
  [path: string]: string | undefined;
}

export interface PhaseCheck {
  ok: boolean;
  score: number;
  signals: string[];
  missingRequiredSignals: string[];
  failReason?: string;
}

const REQUIRED_BY_PHASE: Record<CodebasePhase, readonly string[]> = {
  1: [
    'index-present',
    'launch-board-title',
    'status-columns',
    'task-entry-form',
    'seed-tasks',
    'localstorage',
    'inline-js-parses',
    'phase1-monolithic',
  ],
  2: [
    'index-present',
    'launch-board-title',
    'status-columns',
    'task-entry-form',
    'seed-tasks',
    'localstorage',
    'inline-js-parses',
    'priority-values',
    'priority-input',
    'priority-filter',
  ],
  3: [
    'index-present',
    'launch-board-title',
    'status-columns',
    'task-entry-form',
    'seed-tasks',
    'localstorage',
    'inline-js-parses',
    'priority-values',
    'priority-input',
    'priority-filter',
    'due-date-input',
    'due-summary',
    'date-logic',
  ],
  4: [
    'index-present',
    'launch-board-title',
    'status-columns',
    'task-entry-form',
    'seed-tasks',
    'localstorage',
    'priority-values',
    'priority-input',
    'priority-filter',
    'due-date-input',
    'due-summary',
    'date-logic',
    'module-script',
    'src-state-module',
    'src-render-module',
    'src-app-module',
    'module-imports-exports',
    'inline-js-small',
    'module-syntax',
  ],
};

const FAIL_HINTS: Record<string, string> = {
  'index-present': '`index.html` must exist at the workspace root.',
  'launch-board-title': '`index.html` must clearly name the app "Launch Board".',
  'status-columns': 'The board must include Backlog, Doing, and Done sections.',
  'task-entry-form': 'The app needs an input/form control for adding launch tasks.',
  'seed-tasks':
    'Include at least three seeded task objects/items so the board is not empty; title/text/name/label/content/description fields or task factory calls are acceptable.',
  localstorage: 'Use localStorage so tasks persist across reloads.',
  'inline-js-parses': 'Inline JavaScript must parse cleanly while the app is monolithic.',
  'phase1-monolithic':
    'Phase 1 must be a monolithic `index.html` with substantial inline JavaScript and no `src/` JS files yet.',
  'priority-values':
    'Priority support must include the literal Low, Medium, and High values in task data and/or visible option labels.',
  'priority-input': 'The add-task form must let the user choose a priority.',
  'priority-filter':
    'The UI/code must include a priority filter for visible tasks and render only matching tasks when a priority is selected.',
  'due-date-input': 'The add-task form must include a due date input.',
  'due-summary': 'The UI must show Overdue, Today, and Upcoming summary counts.',
  'date-logic': 'The code must compute due-date status using Date/dueDate logic.',
  'module-script': '`index.html` must load `src/app.js` with a module script.',
  'src-state-module': '`src/state.js` must exist and own task state/storage behavior.',
  'src-render-module': '`src/render.js` must exist and own rendering behavior.',
  'src-app-module': '`src/app.js` must exist and wire imports/events/init.',
  'module-imports-exports': 'The refactor must use real ES module imports/exports.',
  'inline-js-small': '`index.html` should not keep the old app logic inline after the refactor.',
  'module-syntax':
    'Every JS module under `src/` must parse and its local imports must match exported names.',
};

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.?\//, '');
}

function file(files: CodebaseFiles, path: string): string {
  return files[normalizePath(path)] ?? '';
}

function has(files: CodebaseFiles, path: string): boolean {
  return file(files, path).trim().length > 0;
}

function combinedSource(files: CodebaseFiles): string {
  return [file(files, INDEX_PATH), ...MODULE_PATHS.map((path) => file(files, path))].join('\n');
}

function sourceTextFromFiles(files: CodebaseFiles): string {
  return Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, text]) => `# ${path}\n${text}`)
    .join('\n\n---\n\n');
}

function moduleFilesPresent(files: CodebaseFiles): boolean {
  return MODULE_PATHS.some((path) => has(files, path));
}

function inlineStats(html: string): { bytes: number; parses: boolean; firstError?: string } {
  const scripts = extractInlineScripts(html);
  const validation = validateScriptSyntax(scripts);
  return {
    bytes: validation.totalBytes,
    parses: validation.allParse,
    firstError: validation.firstError,
  };
}

function countTaskLikeObjects(source: string): number {
  const objectFields = [...source.matchAll(/\b(?:title|text|name|label|content|description)\s*:/gi)]
    .length;
  const factoryCalls = [
    ...source.matchAll(/\b(?:add|create|seed)Task\s*\(\s*(["'`])(?:(?!\1)[\s\S]){3,}?\1/gi),
  ].length;
  return objectFields + factoryCalls;
}

export function checkCodebasePhase(
  files: CodebaseFiles,
  phase: CodebasePhase,
  opts: { moduleSyntaxOk?: boolean; moduleSyntaxError?: string } = {},
): PhaseCheck {
  const html = file(files, INDEX_PATH);
  const source = combinedSource(files);
  const inline = inlineStats(html);
  const signals: string[] = [];

  if (html.trim().length > 0) signals.push('index-present');
  if (/Launch\s+Board/i.test(html)) signals.push('launch-board-title');
  if (/\bBacklog\b/i.test(source) && /\bDoing\b/i.test(source) && /\bDone\b/i.test(source)) {
    signals.push('status-columns');
  }
  if (
    /<(?:form|input|textarea|select)\b/i.test(html) &&
    /(?:add|new)[-\s_]*(?:task|card)|task[-\s_]*(?:title|input|name)/i.test(source)
  ) {
    signals.push('task-entry-form');
  }
  if (countTaskLikeObjects(source) >= 3) signals.push('seed-tasks');
  if (/localStorage/i.test(source)) signals.push('localstorage');
  if (inline.parses) signals.push('inline-js-parses');
  if (inline.bytes >= 500 && !moduleFilesPresent(files)) signals.push('phase1-monolithic');

  if (/\bLow\b/i.test(source) && /\bMedium\b/i.test(source) && /\bHigh\b/i.test(source)) {
    signals.push('priority-values');
  }
  if (
    /priority/i.test(html) &&
    /<(?:select|input)[^>]*(?:priority|radio)|<option[^>]*>\s*(?:Low|Medium|High)\s*</is.test(html)
  ) {
    signals.push('priority-input');
  }
  const hasPriorityFilterVariable =
    /\b\w*priority\w*filter\w*\b/i.test(source) ||
    /\b\w*filter\w*priority\w*\b/i.test(source) ||
    /priority[-_\s]+filter|filter[-_\s]+priority/i.test(source);
  const hasPriorityComparison =
    /\b[A-Za-z_$][\w$]*\s*\.\s*priority\s*(?:={2,3}|!==?)\s*[\w.]+/i.test(source) ||
    /[\w.]+\s*(?:={2,3}|!==?)\s*[A-Za-z_$][\w$]*\s*\.\s*priority/i.test(source);
  const hasPriorityFilterPredicate =
    /\.filter\s*\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>[\s\S]{0,240}\1\s*\.\s*priority/i.test(
      source,
    ) ||
    /\.filter\s*\(\s*function\s*\(\s*([A-Za-z_$][\w$]*)\s*\)[\s\S]{0,240}\1\s*\.\s*priority/i.test(
      source,
    );
  if (
    /filter/i.test(source) &&
    /priority/i.test(source) &&
    (hasPriorityFilterPredicate || (hasPriorityFilterVariable && hasPriorityComparison))
  ) {
    signals.push('priority-filter');
  }

  if (/(?:type\s*=\s*["']date["']|due[-_\s]?date|dueDate)/i.test(html)) {
    signals.push('due-date-input');
  }
  if (/\bOverdue\b/i.test(html) && /\bToday\b/i.test(html) && /\bUpcoming\b/i.test(html)) {
    signals.push('due-summary');
  }
  if (
    /dueDate|due[-_\s]?date/i.test(source) &&
    /new\s+Date\s*\(|Date\.now|toISOString|setHours|getFullYear|getMonth|getDate/i.test(source)
  ) {
    signals.push('date-logic');
  }

  if (
    /<script\b[^>]*type\s*=\s*["']module["'][^>]*src\s*=\s*["']\.?\/?src\/app\.js["'][^>]*>/i.test(
      html,
    )
  ) {
    signals.push('module-script');
  }
  const state = file(files, STATE_PATH);
  const render = file(files, RENDER_PATH);
  const app = file(files, APP_PATH);
  if (state.length >= 200 && /localStorage|tasks|load|save/i.test(state)) {
    signals.push('src-state-module');
  }
  if (
    render.length >= 200 &&
    /render/i.test(render) &&
    /document|createElement|innerHTML/i.test(render)
  ) {
    signals.push('src-render-module');
  }
  if (app.length >= 150 && /addEventListener|init|render/i.test(app)) {
    signals.push('src-app-module');
  }
  if (
    MODULE_PATHS.some((path) => /^\s*export\b/m.test(file(files, path))) &&
    MODULE_PATHS.some((path) => /^\s*import\b/m.test(file(files, path)))
  ) {
    signals.push('module-imports-exports');
  }
  if (inline.bytes <= 200) signals.push('inline-js-small');
  if (opts.moduleSyntaxOk) signals.push('module-syntax');

  const required = REQUIRED_BY_PHASE[phase];
  const missingRequiredSignals = required.filter((signal) => !signals.includes(signal));
  const firstMissing = missingRequiredSignals[0];
  const failReason = firstMissing
    ? `${firstMissing}: ${FAIL_HINTS[firstMissing] ?? 'required signal missing'}${
        firstMissing === 'inline-js-parses' && inline.firstError
          ? ` (${inline.firstError.slice(0, 160)})`
          : ''
      }${firstMissing === 'module-syntax' && opts.moduleSyntaxError ? ` (${opts.moduleSyntaxError})` : ''}`
    : undefined;

  return {
    ok: missingRequiredSignals.length === 0,
    score: signals.filter((signal) => required.includes(signal)).length,
    signals,
    missingRequiredSignals,
    ...(failReason ? { failReason } : {}),
  };
}

function simpleHash(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function codebaseRuntimeArtifactKey(files: CodebaseFiles): string {
  return [INDEX_PATH, ...MODULE_PATHS]
    .map((path) => `${path}:${simpleHash(file(files, path))}`)
    .join('|');
}

async function findProjectId(client: GezelClient): Promise<string | null> {
  const { projects } = await client.listProjects();
  return projects.find((p) => p.name === PROJECT_NAME)?.id ?? null;
}

async function resolveDeveloperId(client: GezelClient): Promise<string | null> {
  const { gezels } = await client.listGezels();
  return gezels.find((g) => g.name === DEVELOPER_NAME)?.id ?? null;
}

async function readWorkspaceFiles(client: GezelClient, projectId: string): Promise<CodebaseFiles> {
  const out: CodebaseFiles = {};
  try {
    const list = await client.listProjectWorkspace(projectId, undefined, true);
    for (const f of list.files) {
      if (f.isDirectory) continue;
      if (!/\.(?:html|js)$/i.test(f.path)) continue;
      const blob = await client.fetchProjectWorkspaceBlob(projectId, f.path);
      out[normalizePath(f.path)] = await blob.text();
    }
  } catch {
    // Empty workspace: return empty object and let the grader name the miss.
  }
  return out;
}

const syntaxCache = new WeakMap<EvalContext, { hash: string; ok: boolean; reason?: string }>();
const runtimeCache = new WeakMap<EvalContext, { hash: string; report: RuntimeReport }>();

interface ModuleImport {
  source: string;
  names: string[];
  defaultName?: string;
  namespaceName?: string;
}

interface ModuleExports {
  names: Set<string>;
  hasDefault: boolean;
  duplicateNames: string[];
}

function normalizeModuleSpecifier(fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const fromParts = fromPath.split('/');
  fromParts.pop();
  const out: string[] = [...fromParts];
  for (const part of specifier.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  const normalized = out.join('/');
  return normalized.endsWith('.js') ? normalized : `${normalized}.js`;
}

function parseNamedList(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name] = part.split(/\s+as\s+/i);
      return (name ?? '').trim();
    })
    .filter(Boolean);
}

function parseExportNamedList(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const pieces = part.split(/\s+as\s+/i);
      return (pieces[1] ?? pieces[0] ?? '').trim();
    })
    .filter(Boolean);
}

function splitTopLevelDeclarations(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;

  for (const char of text) {
    current += char;
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0) {
      parts.push(current.slice(0, -1));
      current = '';
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function parseImports(source: string): ModuleImport[] {
  const imports: ModuleImport[] = [];
  const importRe = /^\s*import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']\s*;?/gm;
  for (const match of source.matchAll(importRe)) {
    const clause = match[1]?.trim() ?? '';
    const specifier = match[2] ?? '';
    const named = clause.match(/\{([\s\S]*?)\}/);
    const names = named ? parseNamedList(named[1] ?? '') : [];
    const beforeNamed = named ? clause.slice(0, named.index).replace(/,\s*$/, '').trim() : clause;
    const defaultName =
      beforeNamed && !beforeNamed.startsWith('*') && !beforeNamed.startsWith('{')
        ? beforeNamed
        : undefined;
    const namespaceName = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/)?.[1];
    imports.push({
      source: specifier,
      names,
      ...(defaultName ? { defaultName } : {}),
      ...(namespaceName ? { namespaceName } : {}),
    });
  }
  const sideEffectRe = /^\s*import\s+["']([^"']+)["']\s*;?/gm;
  for (const match of source.matchAll(sideEffectRe)) {
    imports.push({ source: match[1] ?? '', names: [] });
  }
  return imports;
}

function parseExports(source: string): ModuleExports {
  const names = new Set<string>();
  const duplicateNames = new Set<string>();
  let hasDefault = false;
  const addExport = (name: string) => {
    if (names.has(name)) duplicateNames.add(name);
    names.add(name);
  };
  for (const match of source.matchAll(
    /^\s*export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    addExport(match[1]!);
  }
  for (const match of source.matchAll(/^\s*export\s+(?:const|let|var)\s+([^;]+)/gm)) {
    const declaration = match[1] ?? '';
    for (const part of splitTopLevelDeclarations(declaration)) {
      const name = part.trim().match(/^([A-Za-z_$][\w$]*)/)?.[1];
      if (name) addExport(name);
    }
  }
  for (const match of source.matchAll(
    /^\s*export\s*\{([\s\S]*?)\}\s*(?:from\s+["'][^"']+["'])?\s*;?/gm,
  )) {
    for (const name of parseExportNamedList(match[1] ?? '')) addExport(name);
  }
  const defaultExports = [...source.matchAll(/^\s*export\s+default\b/gm)].length;
  hasDefault = defaultExports > 0;
  if (defaultExports > 1) duplicateNames.add('default');
  return { names, hasDefault, duplicateNames: [...duplicateNames] };
}

export function checkModuleGraph(files: CodebaseFiles): { ok: boolean; reason?: string } {
  const exportsByPath = new Map<string, ModuleExports>();
  for (const path of MODULE_PATHS) exportsByPath.set(path, parseExports(file(files, path)));

  for (const [path, moduleExports] of exportsByPath) {
    if (moduleExports.duplicateNames.length > 0) {
      return {
        ok: false,
        reason: `${path}: duplicate exports ${moduleExports.duplicateNames.join(', ')}`,
      };
    }
  }

  for (const path of MODULE_PATHS) {
    for (const entry of parseImports(file(files, path))) {
      const target = normalizeModuleSpecifier(path, entry.source);
      if (!target) continue;
      const targetExports = exportsByPath.get(target);
      if (!targetExports)
        return { ok: false, reason: `${path}: imports missing local module ${entry.source}` };
      if (entry.defaultName && !targetExports.hasDefault) {
        return {
          ok: false,
          reason: `${path}: imports default from ${entry.source}, but it has no default export`,
        };
      }
      const missing = entry.names.filter((name) => !targetExports.names.has(name));
      if (missing.length > 0) {
        return {
          ok: false,
          reason: `${path}: imports ${missing.join(', ')} from ${entry.source}, but ${missing.length === 1 ? 'it is' : 'they are'} not exported`,
        };
      }
      if (entry.namespaceName) {
        const memberRe = new RegExp(`\\b${entry.namespaceName}\\.([A-Za-z_$][\\w$]*)`, 'g');
        const missingMembers = [...file(files, path).matchAll(memberRe)]
          .map((match) => match[1])
          .filter((name): name is string => Boolean(name))
          .filter((name) => !targetExports.names.has(name) && name !== 'default');
        const uniqueMissing = [...new Set(missingMembers)];
        if (uniqueMissing.length > 0) {
          return {
            ok: false,
            reason: `${path}: uses ${entry.namespaceName}.${uniqueMissing.join(`, ${entry.namespaceName}.`)} from ${entry.source}, but ${uniqueMissing.length === 1 ? 'it is' : 'they are'} not exported`,
          };
        }
      }
    }
  }
  return { ok: true };
}

async function checkModuleSyntax(
  ctx: EvalContext,
  projectId: string,
  files: CodebaseFiles,
): Promise<{ ok: boolean; reason?: string }> {
  const hash = MODULE_PATHS.map((path) => `${path}:${simpleHash(file(files, path))}`).join('|');
  const cached = syntaxCache.get(ctx);
  if (cached?.hash === hash) return { ok: cached.ok, reason: cached.reason };

  if (!MODULE_PATHS.every((path) => has(files, path))) {
    const result = { ok: false, reason: 'module files are not all present yet' };
    syntaxCache.set(ctx, { hash, ...result });
    return result;
  }

  const tmp = await mkdtemp(`${tmpdir()}/gezel-eval-codebase-evolution-`);
  try {
    await materializeProjectWorkspace(clientFromCtx(ctx), projectId, tmp, {
      include: /\.(?:html|js)$/i,
    });
    for (const path of MODULE_PATHS) {
      const result = await spawnAndAwait(process.execPath, ['--check', join(tmp, path)], {
        timeoutMs: 10_000,
        maxOutputBytes: 16 * 1024,
      });
      if (result.exitCode !== 0) {
        const reason = `${path}: ${(result.stderr || result.stdout).slice(0, 300)}`;
        syntaxCache.set(ctx, { hash, ok: false, reason });
        return { ok: false, reason };
      }
    }
    const graph = checkModuleGraph(files);
    if (!graph.ok) {
      syntaxCache.set(ctx, { hash, ok: false, reason: graph.reason });
      return graph;
    }
    syntaxCache.set(ctx, { hash, ok: true });
    return { ok: true };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

export async function checkCodebaseRuntime(
  ctx: EvalContext,
  projectId: string,
  files: CodebaseFiles,
): Promise<RuntimeReport> {
  const hash = codebaseRuntimeArtifactKey(files);
  const cached = runtimeCache.get(ctx);
  if (cached?.hash === hash) return cached.report;

  const report: RuntimeReport = {
    ran: false,
    passed: [],
    failed: [],
    pageErrors: [],
  };

  let chromium: typeof import('playwright').chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    report.bootstrapError = `playwright import failed: ${err instanceof Error ? err.message : String(err)}`;
    runtimeCache.set(ctx, { hash, report });
    return report;
  }

  const tmp = await mkdtemp(`${tmpdir()}/gezel-eval-codebase-evolution-runtime-`);
  // biome-ignore lint/suspicious/noExplicitAny: keep Playwright optional at type level
  let browser: any = null;
  let staticServer: { url: string; close: () => Promise<void> } | null = null;
  try {
    await materializeProjectWorkspace(clientFromCtx(ctx), projectId, tmp, {
      include: /\.(?:html|js)$/i,
    });
    staticServer = await startStaticServer(tmp);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', (err: Error) => {
      report.pageErrors.push(err.message);
    });
    page.on('console', (msg: { type: () => string; text: () => string }) => {
      if (msg.type() === 'error') report.pageErrors.push(msg.text());
    });

    await page.goto(staticServer.url, {
      waitUntil: 'domcontentloaded',
      timeout: 15_000,
    });
    report.ran = true;
    await page.waitForTimeout(500);

    if (report.pageErrors.length === 0) {
      report.passed.push('no-page-errors');
    } else {
      report.failed.push({
        name: 'no-page-errors',
        why: report.pageErrors.slice(0, 3).join(' | '),
      });
    }

    const renderedSeedCount = await page.evaluate((selector: string) => {
      const candidates = Array.from(document.querySelectorAll(selector));
      return candidates.filter((el) => {
        if (el.closest('select')) return false;
        const text = (el.textContent ?? '').trim();
        if (!text) return false;
        return !/^(Backlog|Doing|Done|Low|Medium|High|All(?: priorities?)?)$/i.test(text);
      }).length;
    }, RENDERED_TASK_SELECTOR);
    if (renderedSeedCount >= 3) {
      report.passed.push('seed-tasks-render');
    } else {
      report.failed.push({
        name: 'seed-tasks-render',
        why: `expected at least 3 rendered task cards/items, found ${renderedSeedCount}`,
      });
    }

    const addResult = await page.evaluate(() => {
      function setValue(
        el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
        value: string,
      ) {
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      const title =
        document.querySelector<HTMLInputElement>('input[type="text"]') ??
        document.querySelector<HTMLInputElement>('input:not([type])') ??
        document.querySelector<HTMLTextAreaElement>('textarea');
      if (!title) return { ok: false, why: 'no text input or textarea for a task title' };
      setValue(title, 'Runtime smoke task');

      const dateInput = document.querySelector<HTMLInputElement>('input[type="date"]');
      if (dateInput) setValue(dateInput, new Date().toISOString().slice(0, 10));

      const prioritySelect = Array.from(
        document.querySelectorAll<HTMLSelectElement>('select'),
      ).find((select) =>
        Array.from(select.options).some((option) => /High/i.test(option.textContent ?? '')),
      );
      if (prioritySelect) setValue(prioritySelect, 'High');

      const form = title.closest('form') ?? document.querySelector('form');
      if (form) {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      } else {
        const button =
          document.querySelector<HTMLButtonElement>('button[type="submit"]') ??
          document.querySelector<HTMLButtonElement>('button');
        button?.click();
      }

      const bodyText = document.body.textContent ?? '';
      const storageText = Object.keys(localStorage)
        .map((key) => localStorage.getItem(key) ?? '')
        .join('\n');
      if (!bodyText.includes('Runtime smoke task')) {
        return { ok: false, why: 'submitted task did not appear in the rendered page' };
      }
      if (!storageText.includes('Runtime smoke task')) {
        return { ok: false, why: 'submitted task did not persist to localStorage' };
      }
      return { ok: true };
    });
    if (addResult.ok) {
      report.passed.push('add-task-persists');
    } else {
      report.failed.push({ name: 'add-task-persists', why: addResult.why });
    }
  } catch (err) {
    report.bootstrapError = `chromium launch/load failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // best-effort teardown
      }
    }
    if (staticServer) await staticServer.close().catch(() => {});
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  runtimeCache.set(ctx, { hash, report });
  return report;
}

function formatRuntimeReport(report: RuntimeReport): string {
  if (!report.ran) {
    return `[scenario] codebase-evolution#runtime BOOTSTRAP_FAIL "${report.bootstrapError ?? 'unknown'}"`;
  }
  const failedSummary = report.failed
    .map((f) => `${f.name}: ${f.why.replace(/\s+/g, ' ').slice(0, 180)}`)
    .join(' | ');
  return `[scenario] codebase-evolution#runtime passed=${report.passed.length} failed=${report.failed.length}${failedSummary ? ` failures: ${failedSummary}` : ''}${report.pageErrors.length ? ` pageErrors=${report.pageErrors.length}` : ''}`;
}

async function startStaticServer(
  rootDir: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const root = resolve(rootDir);
  const contentTypes: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  };
  const server: Server = createServer(async (req, res) => {
    try {
      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
      const target = resolve(root, `.${decodeURIComponent(pathname)}`);
      if (target !== root && !target.startsWith(`${root}${sep}`)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      const body = await readFile(target);
      res
        .writeHead(200, {
          'content-type': contentTypes[extname(target).toLowerCase()] ?? 'application/octet-stream',
        })
        .end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/index.html`,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      }),
  };
}

function clientFromCtx(ctx: EvalContext): GezelClient {
  return ctx.client;
}

async function setup({ client, log }: EvalContext): Promise<void> {
  let projectId = await findProjectId(client);
  if (!projectId) {
    const created = await client.createProject({
      name: PROJECT_NAME,
      about:
        'A small Launch Board web app that will evolve over several user requests. The work starts as a monolithic index.html, gains two small features, then is refactored into ES modules while preserving behavior.',
      missionObjectives: CODEBASE_EVOLUTION_MISSION,
    });
    projectId = created.id;
    log(`[scenario:setup] created project name="${PROJECT_NAME}" id=${projectId}`);
  } else {
    log(`[scenario:setup] reusing existing project id=${projectId}`);
  }
  if (!projectId) throw new Error('codebase-evolution setup: failed to resolve project id');

  let dev: { id: string };
  try {
    const created = await client.createGezel({ name: DEVELOPER_NAME, role: 'Developer' });
    dev = { id: created.id };
    log(`[scenario:setup] created developer "${DEVELOPER_NAME}" id=${dev.id}`);
  } catch (err) {
    const existingId = await resolveDeveloperId(client);
    if (!existingId) throw err;
    dev = { id: existingId };
    log(`[scenario:setup] reusing developer "${DEVELOPER_NAME}" id=${dev.id}`);
  }
  await client.addGezelToProject(projectId, dev.id);
  log(`[scenario:setup] joined ${DEVELOPER_NAME} to project ${projectId}`);

  await client.sendChatMessage(dev.id, { message: PHASE_1_MESSAGE, projectId });
  log(`[scenario:setup] sent phase 1 kickoff to ${DEVELOPER_NAME} in project ${projectId}`);
}

export interface CodebaseEvolutionState {
  phase: CodebasePhase;
  sentAt: number;
  devId: string | null;
  runtimeFailureKey?: string;
  runtimeFailureAttemptKey?: string;
  runtimeFailureCount: number;
}

const stateByCtx = new WeakMap<EvalContext, CodebaseEvolutionState>();
const PHASE_GRACE_MS = 90_000;
const PHASE_REPAIR_INFLIGHT_DEFER_MS = 90_000;
const RUNTIME_FAILURE_ATTEMPT_LIMIT = 6;

export function codebaseRuntimeFailureKey(report: RuntimeReport): string {
  return report.failed
    .map((failure) => failure.name)
    .sort()
    .join(',');
}

export function recordCodebaseRuntimeFailureAttempt(
  state: Pick<
    CodebaseEvolutionState,
    'runtimeFailureKey' | 'runtimeFailureAttemptKey' | 'runtimeFailureCount'
  >,
  report: RuntimeReport,
  artifactKey: string,
): number {
  const runtimeKey = codebaseRuntimeFailureKey(report);
  const attemptKey = `${runtimeKey}::${artifactKey}`;
  if (state.runtimeFailureAttemptKey === attemptKey) {
    return state.runtimeFailureCount;
  }
  if (state.runtimeFailureKey === runtimeKey) {
    state.runtimeFailureCount += 1;
  } else {
    state.runtimeFailureKey = runtimeKey;
    state.runtimeFailureCount = 1;
  }
  state.runtimeFailureAttemptKey = attemptKey;
  return state.runtimeFailureCount;
}

function repairDirectiveForPhase(phase: CodebasePhase, failReason: string): string {
  const prefix = `CODEBASE_EVOLUTION_PHASE_${phase}: patch the existing Launch Board codebase for the current phase only. ${failReason}`;
  if (phase === 2) {
    return [
      prefix,
      'Your next assistant action must edit the current `index.html`; do not reply with a plan or create a new project.',
      'Add priority as real app state in one patch: literal Low, Medium, and High values; a `priority` field on every seeded task; selected priority stored on newly added tasks; a visible priority select/input in the add-task form; a visible priority filter; and filtering logic that keeps only tasks matching the selected priority.',
      'Preserve the existing Launch Board title, Backlog/Doing/Done columns, seeded tasks, localStorage persistence, and parseable inline JavaScript.',
    ].join(' ');
  }
  if (phase === 3) {
    return [
      prefix,
      'Your next assistant action must edit `index.html` for due dates specifically; do not spend another turn polishing priority-only UI.',
      'Make this exact mechanical patch in one edit: add `<input type="date" id="dueDateInput" name="dueDate">` inside the existing add-task form; add `dueDate` to every seeded task object; in the submit handler read `document.getElementById("dueDateInput").value`; push new tasks with `dueDate`; render the due date on each task card; and clear the date input after submit.',
      'Add a visible summary block near the filters with the labels `Overdue`, `Today`, and `Upcoming`, each with a count span. Compute the counts from `new Date(task.dueDate)` or `new Date(task.dueDate + "T00:00:00")` compared with today, and update those spans in `render()`.',
      'Self-check before replying: `index.html` must literally contain `id="dueDateInput"`, `dueDate`, `Overdue`, `Today`, `Upcoming`, and `new Date(task.dueDate`; if any of those strings are absent, the patch is not done.',
      'The next edit must add the date input, the stored task field, rendered due date text, and summary/count logic in the same patch; do not only adjust styles, labels, or priority controls.',
      'Preserve priority values, the priority input, the priority filter, the board columns, seeded tasks, localStorage persistence, and parseable inline JavaScript.',
    ].join(' ');
  }
  if (phase === 4) {
    return [
      prefix,
      'Your next assistant action must be workspace `write_file` calls for the module split, not a chat-only plan and not another small `index.html` patch.',
      'Create or update all four relevant files in this repair: `index.html`, `src/state.js`, `src/render.js`, and `src/app.js`.',
      'Use workspace `write_file` paths relative to the workspace root; make multiple `write_file` calls in one turn for the module split if needed.',
      'If the remaining miss is the HTML shell, rewrite `index.html` to remove all inline app JavaScript and add exactly `<script type="module" src="./src/app.js"></script>` before `</body>`.',
      'If the remaining miss is due-date logic, patch the module that renders the summary. Store/backfill the task field as `dueDate`, not only `due`, and compute each bucket with `new Date(task.dueDate + "T00:00:00")` compared with `new Date()`; do not leave an undefined `today`/`todayStr` variable mismatch.',
      'If the remaining miss is the due summary, keep visible `Overdue`, `Today`, and `Upcoming` labels in `index.html` and update their count spans from `src/render.js`.',
      'Refactor without changing behavior: keep index.html as a thin shell that imports `src/app.js`, move task data/storage helpers to `src/state.js`, move DOM rendering/filtering/summary UI to `src/render.js`, and keep startup/event wiring in `src/app.js`.',
      'Keep Launch Board title, Backlog/Doing/Done board, task form, priority filter, due-date input, Overdue/Today/Upcoming summary, seeded tasks, and localStorage behavior working.',
    ].join(' ');
  }
  return `${prefix} Do not create a fresh unrelated app or new project; edit the current workspace files in place and preserve signals that already pass.`;
}

function nextPhaseMessage(phase: CodebasePhase): string {
  if (phase === 2) return PHASE_2_MESSAGE;
  if (phase === 3) return PHASE_3_MESSAGE;
  if (phase === 4) return PHASE_4_MESSAGE;
  throw new Error(`no next phase message for phase ${phase}`);
}

export function feedbackPathForPhase(phase: CodebasePhase, check: PhaseCheck): string {
  if (phase !== 4) return INDEX_PATH;
  const missing = new Set(check.missingRequiredSignals);
  const reason = check.failReason ?? '';
  if (
    missing.has('module-script') ||
    missing.has('inline-js-small') ||
    /index\.html/i.test(reason)
  ) {
    return INDEX_PATH;
  }
  if (missing.has('src-state-module')) return STATE_PATH;
  if (missing.has('src-render-module')) return RENDER_PATH;
  if (missing.has('src-app-module')) return APP_PATH;
  if (missing.has('seed-tasks')) return STATE_PATH;
  if (missing.has('date-logic')) return RENDER_PATH;
  if (missing.has('due-summary')) return INDEX_PATH;
  if (/src\/state\.js/i.test(reason)) return STATE_PATH;
  if (/src\/render\.js/i.test(reason)) return RENDER_PATH;
  if (/src\/app\.js/i.test(reason)) return APP_PATH;
  return APP_PATH;
}

export const codebaseEvolutionScenario: EvalScenario = {
  id: 'codebase-evolution',
  description:
    'Phased codebase iteration: build a monolithic Launch Board app, add priority filtering, add due-date summaries, then refactor the inline JS into src/state.js, src/render.js, and src/app.js without losing features.',
  prompt: [
    `Heads up: ${DEVELOPER_NAME} is evolving a Launch Board codebase in the "${PROJECT_NAME}" project.`,
    'The user will send additional phase requests as earlier phases pass.',
    "You don't need to do anything — just confirm you've seen this note.",
  ].join(' '),
  requiredPromptEvidence: [
    { signal: 'launch-board-title', pattern: /launch board/ },
    { signal: 'status-columns', pattern: /backlog[\s\S]*doing[\s\S]*done/ },
    { signal: 'priority-filter', pattern: /priority[\s\S]*filter|filter[\s\S]*priority/ },
    { signal: 'due-summary', pattern: /overdue[\s\S]*today[\s\S]*upcoming/ },
    {
      signal: 'module-refactor',
      pattern: /src\/state\.js[\s\S]*src\/render\.js[\s\S]*src\/app\.js/,
    },
  ],
  evidenceTexts: [
    CODEBASE_EVOLUTION_MISSION,
    PHASE_1_MESSAGE,
    PHASE_2_MESSAGE,
    PHASE_3_MESSAGE,
    PHASE_4_MESSAGE,
  ],
  timeoutMs: 45 * 60_000,
  progressTimeoutMs: 15 * 60_000,
  setup,
  skipInitialPrompt: true,
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const { client, log, logChanged, recordSniff } = ctx;
    const projectId = await findProjectId(client);
    if (!projectId) {
      logChanged('project', '[scenario] Launch Board project not present yet');
      return { done: false };
    }

    let state = stateByCtx.get(ctx);
    if (!state) {
      state = { phase: 1, sentAt: 0, devId: null, runtimeFailureCount: 0 };
      stateByCtx.set(ctx, state);
    }

    const files = await readWorkspaceFiles(client, projectId);
    const totalBytes = Object.values(files).reduce((sum, text) => sum + (text?.length ?? 0), 0);
    if (!has(files, INDEX_PATH)) {
      logChanged('sniff', '[scenario] codebase-evolution index.html not present yet');
      recordSniff?.({ key: 'codebase-evolution', score: 0, bytes: totalBytes });
      await postMissingDeliverableFeedback(ctx, INDEX_PATH, {
        minPolls: 12,
        repeatEvery: 12,
        maxNudges: 3,
        inflightGraceMs: 7 * 60_000,
        projectId,
      });
      return { done: false };
    }

    const syntax =
      state.phase === 4 ? await checkModuleSyntax(ctx, projectId, files) : { ok: true as const };
    const check = checkCodebasePhase(files, state.phase, {
      moduleSyntaxOk: syntax.ok,
      moduleSyntaxError: syntax.reason,
    });
    const max = REQUIRED_BY_PHASE[state.phase].length;
    const score = (state.phase - 1) * 30 + check.score;
    logChanged(
      'sniff',
      `[scenario] codebase-evolution phase=${state.phase} bytes=${totalBytes} score=${check.score}/${max} signals=${check.signals.join(',') || 'none'}${check.failReason ? ` failReason="${check.failReason}"` : ''}`,
    );
    recordSniff?.({
      key: 'codebase-evolution',
      score,
      bytes: totalBytes,
      failReason: check.failReason,
    });

    if (check.ok) {
      if (state.phase === 4) {
        const runtime = await checkCodebaseRuntime(ctx, projectId, files);
        logChanged('codebase-evolution-runtime', formatRuntimeReport(runtime));
        recordSniff?.({
          key: 'codebase-evolution',
          score,
          bytes: totalBytes,
          failReason:
            runtime.failed.length > 0
              ? runtime.failed.map((failure) => failure.name).join(',')
              : undefined,
          runtimePassed: runtime.ran ? runtime.passed.length : 0,
          runtimeFailed: runtime.ran ? runtime.failed.length : 0,
        });
        if (!runtime.ran) {
          log(
            `[scenario] runtime check skipped for codebase-evolution (bootstrapError="${runtime.bootstrapError ?? 'unknown'}")`,
          );
          return {
            done: true,
            success: true,
            reason:
              'all four codebase-evolution phases passed static checks; runtime layer unavailable',
          };
        }
        if (runtime.failed.length > 0) {
          const runtimeKey = codebaseRuntimeFailureKey(runtime);
          const runtimeFailureCount = recordCodebaseRuntimeFailureAttempt(
            state,
            runtime,
            codebaseRuntimeArtifactKey(files),
          );
          if (runtimeFailureCount >= RUNTIME_FAILURE_ATTEMPT_LIMIT) {
            return {
              done: true,
              success: false,
              reason: `phase 4 runtime failure repeated ${runtimeFailureCount} time(s) for [${runtimeKey || 'unknown'}]: ${runtime.failed
                .map((failure) => `${failure.name}: ${failure.why}`)
                .join(' | ')}`,
            };
          }
          await postRuntimeFeedback(ctx, INDEX_PATH, runtime, sourceTextFromFiles(files), {
            expectedDeliverable: null,
            extraInstruction: [
              'CODEBASE_EVOLUTION_RUNTIME_REPAIR: this is a multi-file ES module app, not a single-file HTML deliverable.',
              'Keep `index.html` as the thin shell with `<script type="module" src="./src/app.js"></script>` and patch the smallest relevant module instead.',
              'For `seed-tasks-render`, check `src/app.js`, `src/state.js`, and `src/render.js`: the entrypoint should seed/load at least three tasks, call the render function immediately after DOM nodes are available, and render visible task elements with a `.task`, `.card`, `[data-id]`, or `[data-task-id]` marker.',
            ].join(' '),
          });
          return { done: false };
        }
        return {
          done: true,
          success: true,
          reason: `all four codebase-evolution phases passed (final signals: ${check.signals.join(', ')}) + runtime (${runtime.passed.length} assertion(s))`,
        };
      }
      if (!state.devId) state.devId = await resolveDeveloperId(client);
      if (!state.devId) {
        log('[scenario] phase passed but developer not found yet — retrying next poll');
        return { done: false };
      }
      const next = (state.phase + 1) as CodebasePhase;
      try {
        await client.sendChatMessage(state.devId, { message: nextPhaseMessage(next), projectId });
        log(`[scenario] phase ${state.phase} passed — sent phase ${next} request`);
        state.phase = next;
        state.sentAt = Date.now();
        state.runtimeFailureKey = undefined;
        state.runtimeFailureAttemptKey = undefined;
        state.runtimeFailureCount = 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[scenario] failed to send phase ${next} request: ${msg} — retrying next poll`);
      }
      return { done: false };
    }

    const inGrace = state.sentAt > 0 && Date.now() - state.sentAt < PHASE_GRACE_MS;
    if (!inGrace && check.failReason) {
      const sourceText = sourceTextFromFiles(files);
      await postSniffFeedback(ctx, feedbackPathForPhase(state.phase, check), check, {
        projectId,
        sourceText,
        dedupeToken: `phase-${state.phase}:${simpleHash(sourceText)}`,
        repairDirective: repairDirectiveForPhase(state.phase, check.failReason),
        inflightDeferMs: PHASE_REPAIR_INFLIGHT_DEFER_MS,
      });
    }
    return { done: false };
  },
};
