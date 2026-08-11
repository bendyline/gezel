import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandApprovalScope, Question } from '@bendyline/gezel';
import { nowIso } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import { resolvePnpmCommand } from '../packages/pnpm.js';
import {
  type CommandApprovalsFile,
  hashCommandInvocation,
  lookupApproval,
  readCommandApprovals,
} from './command-approvals.js';
import { fingerprintCommandInputs } from './command-inputs.js';
import { type RunWorkspaceCommandResult, runWorkspaceCommand } from './command.js';
import { WorkspaceWriteDeniedError } from './errors.js';

/**
 * Thin glue between the HTTP routes and `runWorkspaceCommand`. Owns
 * the allowlist and approval-gate logic so both tools share identical
 * consent semantics.
 *
 * `run_package_script`: invoked as `pnpm run <name> -- [args]`. Name
 * must exist as a key in the workspace's `package.json#scripts`.
 *
 * `run_npx`: invoked as `<workspace>/node_modules/.bin/<name> [args]`.
 * Name must appear in the union of manifest deps
 * (`dependencies` + `devDependencies`) and `.bin` basenames.
 */

export interface RunScriptsOptions {
  store: Store;
  home: string;
  projectId: string;
  history?: HistoryManager;
  gezelId?: string;
  sessionId?: string;
  timeoutMs?: number;
}

export interface RunPackageScriptOptions extends RunScriptsOptions {
  script: string;
  args?: string[];
}

export interface RunNpxOptions extends RunScriptsOptions {
  bin: string;
  args?: string[];
}

export interface RunCommandOutcome {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  error?: string;
  approvalPending?: boolean;
  questionId?: string;
  declined?: string;
  resolvedBinPath?: string;
}

export async function runPackageScript(opts: RunPackageScriptOptions): Promise<RunCommandOutcome> {
  const gate = await opts.store.assertWorkspaceWritable(opts.projectId);
  if (!gate.ok) throw new WorkspaceWriteDeniedError(gate);

  const { scripts } = await opts.store.readPackageJsonScripts(opts.projectId);
  const body = scripts[opts.script];
  if (typeof body !== 'string') {
    return failure(
      `Script "${opts.script}" is not defined in this project's package.json. ` +
        `Known scripts: ${Object.keys(scripts).join(', ') || '(none)'}.`,
    );
  }

  const approvals = await readCommandApprovals(opts.home, opts.projectId);
  const inputFiles = await fingerprintCommandInputs({
    workspaceDir: gate.workspaceDir,
    body,
    args: opts.args ?? [],
    entryFiles: [join(gate.workspaceDir, 'package.json')],
  });
  const gateOutcome = await checkApprovalGate({
    ...opts,
    approvals,
    scope: 'script',
    name: opts.script,
    body,
    args: opts.args ?? [],
    inputFiles,
  });
  if (gateOutcome) return gateOutcome;

  const invocation = resolvePnpmCommand([
    'run',
    opts.script,
    ...(opts.args && opts.args.length > 0 ? ['--', ...opts.args] : []),
  ]);
  const res = await runWorkspaceCommand({
    bin: invocation.command,
    args: invocation.args,
    cwd: gate.workspaceDir,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
  await logRunEvent(opts, 'script', opts.script, opts.args ?? [], res);
  return toOutcome(res);
}

export async function runNpx(opts: RunNpxOptions): Promise<RunCommandOutcome> {
  const gate = await opts.store.assertWorkspaceWritable(opts.projectId);
  if (!gate.ok) throw new WorkspaceWriteDeniedError(gate);

  const bin = opts.bin.trim();
  if (!bin || /[\\\/]/.test(bin)) {
    return failure(
      `Invalid npx bin "${opts.bin}" — pass a bare binary name (e.g. "vitest"), not a path.`,
    );
  }

  const allowlist = await readNpxAllowlist(gate.workspaceDir);
  if (!allowlist.has(bin)) {
    return failure(
      `"${bin}" is not an installed binary in this project. ` +
        `Install a package that provides it with \`npm_install\`, or pick from: ${
          [...allowlist].slice(0, 20).join(', ') || '(none)'
        }.`,
    );
  }

  const resolvedBinPath = await resolveBinPath(gate.workspaceDir, bin);
  if (!resolvedBinPath) {
    return failure(
      `"${bin}" is listed as a dependency but not yet present in node_modules/.bin. Run dependency install (npm_install) first.`,
    );
  }

  const approvals = await readCommandApprovals(opts.home, opts.projectId);
  const inputFiles = await fingerprintCommandInputs({
    workspaceDir: gate.workspaceDir,
    body: resolvedBinPath,
    args: opts.args ?? [],
    entryFiles: [join(gate.workspaceDir, 'package.json'), resolvedBinPath],
  });
  const gateOutcome = await checkApprovalGate({
    ...opts,
    approvals,
    scope: 'npx',
    name: bin,
    body: resolvedBinPath,
    args: opts.args ?? [],
    inputFiles,
  });
  if (gateOutcome) return { ...gateOutcome, resolvedBinPath };

  const res = await runWorkspaceCommand({
    bin: resolvedBinPath,
    args: opts.args ?? [],
    cwd: gate.workspaceDir,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
  await logRunEvent(opts, 'npx', bin, opts.args ?? [], res);
  return { ...toOutcome(res), resolvedBinPath };
}

// ── approval gate ──────────────────────────────────────────────────────────

interface ApprovalGateInput extends RunScriptsOptions {
  approvals: CommandApprovalsFile;
  scope: CommandApprovalScope;
  name: string;
  body: string;
  args: string[];
  inputFiles: import('@bendyline/gezel').CommandApprovalInputFile[];
}

async function checkApprovalGate(input: ApprovalGateInput): Promise<RunCommandOutcome | undefined> {
  const decision = lookupApproval(
    input.approvals,
    input.scope,
    input.name,
    hashCommandInvocation(input.body, input.args, input.inputFiles),
  );
  if (decision === 'approved') return undefined;
  if (decision === 'declined') {
    const evtKind =
      input.scope === 'script' ? 'workspace.script.declined' : 'workspace.npx.declined';
    await input.history
      ?.log({
        kind: evtKind,
        projectId: input.projectId,
        ...(input.gezelId ? { gezelId: input.gezelId } : {}),
        summary: `Blocked ${input.scope === 'script' ? 'npm run' : 'npx'} ${input.name} — previously declined`,
        details: { name: input.name, args: input.args },
      })
      .catch(() => undefined);
    return {
      ok: false,
      code: -1,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      declined: `User previously declined to run ${input.scope === 'script' ? `npm run ${input.name}` : `npx ${input.name}`}. Try a different approach.`,
    };
  }

  // No decision on file → raise an approval question unless we can't
  // (no session to route the answer back into).
  if (!input.sessionId) {
    return failure(
      `Running ${input.scope === 'script' ? `npm run ${input.name}` : `npx ${input.name}`} requires first-time user approval, but there is no active session to prompt the user. Tell the user what you'd like to run and they can approve it from Project → Packages.`,
    );
  }
  const pending = await findPendingApproval(input);
  if (pending) {
    return {
      ok: false,
      code: -1,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      approvalPending: true,
      questionId: pending.id,
    };
  }
  const question: Question = {
    id: randomUUID(),
    projectId: input.projectId,
    gezelId: input.gezelId ?? '',
    sessionId: input.sessionId,
    prompt: buildApprovalPrompt(input),
    choices: ['Approve', 'Decline'],
    allowWriteIn: false,
    multiSelect: false,
    intent: {
      kind: 'command-approval',
      scope: input.scope,
      name: input.name,
      body: input.body,
      ...(input.args.length > 0 ? { args: input.args } : {}),
      ...(input.inputFiles.length > 0 ? { inputFiles: input.inputFiles } : {}),
    },
    createdAt: nowIso(),
  };
  await input.store.writeQuestion(question);
  return {
    ok: false,
    code: -1,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    approvalPending: true,
    questionId: question.id,
  };
}

async function findPendingApproval(input: ApprovalGateInput): Promise<Question | undefined> {
  const all = await input.store.listProjectQuestions(input.projectId);
  for (const q of all) {
    if (q.answer) continue;
    if (q.intent?.kind !== 'command-approval') continue;
    if (q.intent.scope !== input.scope) continue;
    if (q.intent.name !== input.name) continue;
    if (q.intent.body !== input.body) continue;
    if (JSON.stringify(q.intent.args ?? []) !== JSON.stringify(input.args)) continue;
    if (JSON.stringify(q.intent.inputFiles ?? []) !== JSON.stringify(input.inputFiles)) continue;
    return q;
  }
  return undefined;
}

function buildApprovalPrompt(input: ApprovalGateInput): string {
  const verb = input.scope === 'script' ? `\`npm run ${input.name}\`` : `\`npx ${input.name}\``;
  const bodyBlock = input.body ? `\n\nCommand body:\n\n\`\`\`\n${input.body}\n\`\`\`` : '';
  const argsLine = input.args.length > 0 ? `\n\nExtra args: \`${input.args.join(' ')}\`` : '';
  const shownFiles = input.inputFiles.slice(0, 12);
  const filesBlock =
    shownFiles.length > 0
      ? `\n\nIdentifiable files bound to this approval:\n${shownFiles.map((file) => `- \`${file.path}\` — \`${file.sha256.slice(0, 12)}…\``).join('\n')}${input.inputFiles.length > shownFiles.length ? `\n- …and ${input.inputFiles.length - shownFiles.length} more` : ''}`
      : '';
  return `A gezel wants to run ${verb} in this project.${bodyBlock}${argsLine}${filesBlock}\n\nSecurity warning: package commands are not isolated from your OS account. They can spawn other programs, access the network, and read or modify files outside this project. Approve only if you trust this command, these exact arguments, and the project's dependencies.\n\nApproving stores this decision for this exact command body, argument list, and the identifiable file contents above. Editing one of those files will ask again. Files outside the project, directory or glob contents, dynamically discovered files, implicit configuration, PATH-resolved programs, package imports, and network inputs may not be identifiable in advance.`;
}

// ── npx allowlist ──────────────────────────────────────────────────────────

async function readNpxAllowlist(workspaceDir: string): Promise<Set<string>> {
  const [manifestDeps, binNames] = await Promise.all([
    readManifestDeps(workspaceDir),
    readBinNames(workspaceDir),
  ]);
  return new Set([...manifestDeps, ...binNames]);
}

async function readManifestDeps(workspaceDir: string): Promise<string[]> {
  try {
    const raw = await readFile(join(workspaceDir, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return [
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
    ];
  } catch {
    return [];
  }
}

async function readBinNames(workspaceDir: string): Promise<string[]> {
  const binDir = join(workspaceDir, 'node_modules', '.bin');
  try {
    const entries = await readdir(binDir);
    const names = new Set<string>();
    for (const entry of entries) {
      // On Windows the same binary shows up as `foo`, `foo.cmd`, and
      // `foo.ps1`; strip those suffixes so the allowlist is extension-
      // agnostic. POSIX entries have no extension and pass through.
      const base = entry.replace(/\.(cmd|ps1|bat)$/i, '');
      if (base) names.add(base);
    }
    return [...names];
  } catch {
    return [];
  }
}

async function resolveBinPath(workspaceDir: string, bin: string): Promise<string | null> {
  const base = join(workspaceDir, 'node_modules', '.bin', bin);
  if (process.platform === 'win32') {
    for (const ext of ['.cmd', '.exe', '']) {
      const candidate = base + ext;
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }
  return existsSync(base) ? base : null;
}

// ── helpers ────────────────────────────────────────────────────────────────

function failure(message: string): RunCommandOutcome {
  return {
    ok: false,
    code: -1,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    error: message,
  };
}

function toOutcome(res: RunWorkspaceCommandResult): RunCommandOutcome {
  return {
    ok: res.ok,
    code: res.code,
    stdout: res.stdout,
    stderr: res.stderr,
    stdoutTruncated: res.stdoutTruncated,
    stderrTruncated: res.stderrTruncated,
    timedOut: res.timedOut,
    ...(res.error ? { error: res.error } : {}),
  };
}

async function logRunEvent(
  opts: RunScriptsOptions,
  scope: CommandApprovalScope,
  name: string,
  args: string[],
  res: RunWorkspaceCommandResult,
): Promise<void> {
  if (!opts.history) return;
  const kind = scope === 'script' ? 'workspace.script.run' : 'workspace.npx.run';
  const verb = scope === 'script' ? `npm run ${name}` : `npx ${name}`;
  const summary = res.ok
    ? `Ran ${verb} (exit ${res.code}, ${Math.round(res.durationMs)}ms)`
    : res.timedOut
      ? `Timed out: ${verb}`
      : `Failed: ${verb} (exit ${res.code})`;
  await opts.history
    .log({
      kind,
      projectId: opts.projectId,
      ...(opts.gezelId ? { gezelId: opts.gezelId } : {}),
      summary,
      details: {
        name,
        args,
        exitCode: res.code,
        durationMs: res.durationMs,
        timedOut: res.timedOut,
      },
    })
    .catch(() => undefined);
}
