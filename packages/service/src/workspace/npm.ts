import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  NpmInstallApprovalDecision,
  NpmInstallApprovalPackage,
  Question,
} from '@bendyline/gezel';
import {
  NpmPackageNameSchema,
  NpmRegistryVersionSchema,
  formatNpmRegistrySpec,
} from '@bendyline/gezel';
import { projectPrivateDir } from '@bendyline/gezel/paths';
import type { ChatEventBus } from '../chat/events.js';
import { writeFileAtomic } from '../fs/atomic.js';
import type { Store } from '../fs/store.js';
import { runPnpm } from '../packages/pnpm.js';
import { WorkspaceWriteDeniedError } from './errors.js';

/**
 * Approval-gated npm package installer.
 *
 * Accepts a **batch** of packages per call and returns one outcome per
 * package. Pre-vetted entries install immediately; unknown ones are
 * grouped into a single `npm-install-approval` question so the user
 * approves the whole batch in one prompt.
 *
 * Dedup rules:
 *   - Within a call: duplicate `(package, version)` pairs collapse to
 *     one entry.
 *   - Against pending questions: if any project already has an
 *     unanswered `npm-install-approval` question covering a package,
 *     we don't create a second one — the per-package outcome is
 *     `pending-approval` pointing at the existing question.
 */

export const SHIPPED_ALLOWLIST: ReadonlyArray<{ package: string; allowedVersions: string[] }> = [
  { package: 'zod', allowedVersions: ['^3', '^4'] },
  { package: 'chalk', allowedVersions: ['^5'] },
  { package: 'commander', allowedVersions: ['^12', '^13'] },
  { package: 'date-fns', allowedVersions: ['^3', '^4'] },
  { package: 'yaml', allowedVersions: ['^2'] },
  { package: 'cheerio', allowedVersions: ['^1'] },
  { package: 'mime-types', allowedVersions: ['^2', '^3'] },
  { package: 'marked', allowedVersions: ['^12', '^13', '^14', '^15'] },
  { package: 'nanoid', allowedVersions: ['^5'] },
  { package: 'pino', allowedVersions: ['^9'] },
  { package: 'playwright-core', allowedVersions: ['^1'] },
  { package: 'tsx', allowedVersions: ['^4'] },
  { package: 'typescript', allowedVersions: ['^5'] },
  { package: 'undici', allowedVersions: ['^6', '^7'] },
];

interface AllowlistedEntry {
  package: string;
  version: string;
  at: string;
  approvedBy: 'user' | 'shipped';
  declined?: boolean;
}

interface ProjectAllowlistFile {
  approved: AllowlistedEntry[];
  declined: AllowlistedEntry[];
}

function projectAllowlistPath(home: string, projectId: string): string {
  return join(projectPrivateDir(home, projectId), 'npm-allowlist.json');
}

export async function readProjectAllowlist(
  home: string,
  projectId: string,
): Promise<ProjectAllowlistFile> {
  const file = projectAllowlistPath(home, projectId);
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as ProjectAllowlistFile;
    return {
      approved: Array.isArray(parsed.approved) ? parsed.approved : [],
      declined: Array.isArray(parsed.declined) ? parsed.declined : [],
    };
  } catch {
    return { approved: [], declined: [] };
  }
}

async function writeProjectAllowlist(
  home: string,
  projectId: string,
  data: ProjectAllowlistFile,
): Promise<void> {
  const file = projectAllowlistPath(home, projectId);
  if (!existsSync(dirname(file))) await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
}

function matchesAllowlist(pkg: string, version: string): boolean {
  for (const entry of SHIPPED_ALLOWLIST) {
    if (entry.package !== pkg) continue;
    if (entry.allowedVersions.includes(version) || entry.allowedVersions.includes('*')) return true;
  }
  return false;
}

function matchesProjectApproval(
  allowlist: ProjectAllowlistFile,
  pkg: string,
  version: string,
): boolean {
  return allowlist.approved.some((e) => e.package === pkg && e.version === version);
}

function matchesProjectDecline(
  allowlist: ProjectAllowlistFile,
  pkg: string,
  version: string,
): boolean {
  return allowlist.declined.some((e) => e.package === pkg && e.version === version);
}

export type NpmInstallPackageOutcome =
  | {
      kind: 'installed';
      package: string;
      version: string;
      stdout: string;
      stderr: string;
    }
  | {
      kind: 'pending-approval';
      questionId: string;
      package: string;
      version: string;
      /** True when we reused an existing pending question for the same package. */
      deduped: boolean;
    }
  | {
      kind: 'declined';
      package: string;
      version: string;
      reason: string;
    }
  | {
      kind: 'failed';
      package: string;
      version: string;
      error: string;
      stdout: string;
      stderr: string;
    };

export interface NpmInstallBatchOutcome {
  results: NpmInstallPackageOutcome[];
}

export interface NpmInstallPackageRequest {
  package: string;
  version?: string;
}

export interface RequestNpmInstallsOptions {
  store: Store;
  home: string;
  projectId: string;
  packages: NpmInstallPackageRequest[];
  gezelId?: string;
  sessionId?: string;
  /**
   * Chat events bus — used to publish `question_asked` when a new
   * approval question is created. Without this the question is
   * persisted but the UI never sees it (the approval card never
   * pops up); the gezel sits in "I asked for approval" prose
   * forever and the user has no idea anything is waiting.
   * Optional so callers in tests / non-chat contexts can omit it
   * (the question is still persisted for any later listener).
   */
  chatEvents?: ChatEventBus;
}

/**
 * Normalize an intent's packages list across legacy and batch shapes.
 * Older pending questions on disk carry `package` + `version`; newer
 * ones carry `packages: []`. This helper accepts either and returns a
 * flat array.
 */
export function intentPackages(
  intent: Question['intent'] | undefined,
): NpmInstallApprovalPackage[] {
  if (!intent) return [];
  if (intent.kind !== 'npm-install-approval') return [];
  const raw = intent as unknown as {
    packages?: NpmInstallApprovalPackage[];
    package?: string;
    version?: string;
  };
  if (Array.isArray(raw.packages) && raw.packages.length > 0) return raw.packages;
  if (typeof raw.package === 'string' && typeof raw.version === 'string') {
    return [{ package: raw.package, version: raw.version }];
  }
  return [];
}

/**
 * Batch entry point. See module header for outcome semantics.
 */
export async function requestNpmInstalls(
  opts: RequestNpmInstallsOptions,
): Promise<NpmInstallBatchOutcome> {
  const gate = await opts.store.assertWorkspaceWritable(opts.projectId);
  if (!gate.ok) throw new WorkspaceWriteDeniedError(gate);

  const requested = dedupRequests(opts.packages);
  if (requested.length === 0) {
    return { results: [] };
  }

  // Hermetic-mode kill switch: decline every install — including the
  // shipped allowlist, which normally installs with no approval question.
  // The eval harness sets this so trials never reach the npm registry;
  // the reason text steers the model toward built-ins instead of retry.
  if (process.env.GEZEL_NPM_INSTALL_OFFLINE === '1') {
    return {
      results: requested.map((req) => ({
        kind: 'declined' as const,
        package: req.package,
        version: req.version,
        reason:
          'Package installs are disabled in this environment (offline mode). Do not retry npm_install; write dependency-free code using Node built-ins (fs, path, readline, JSON) instead.',
      })),
    };
  }

  const projectAllow = await readProjectAllowlist(opts.home, opts.projectId);
  const pendingApprovals = await loadPendingApprovalIndex(opts.store, opts.projectId);

  const results: NpmInstallPackageOutcome[] = [];
  const needsApproval: NpmInstallApprovalPackage[] = [];

  for (const req of requested) {
    const pkg = req.package;
    const version = req.version;

    if (matchesProjectDecline(projectAllow, pkg, version)) {
      results.push({
        kind: 'declined',
        package: pkg,
        version,
        reason: 'User previously declined this package. Try a different approach.',
      });
      continue;
    }

    if (matchesAllowlist(pkg, version) || matchesProjectApproval(projectAllow, pkg, version)) {
      const outcome = await installNow(opts.store, gate.workspaceDir, pkg, version, opts.projectId);
      results.push(outcome);
      continue;
    }

    const existing = pendingApprovals.get(keyOf(pkg, version));
    if (existing) {
      results.push({
        kind: 'pending-approval',
        questionId: existing.id,
        package: pkg,
        version,
        deduped: true,
      });
      continue;
    }

    needsApproval.push({ package: pkg, version });
  }

  if (needsApproval.length > 0) {
    if (!opts.sessionId) {
      for (const p of needsApproval) {
        results.push({
          kind: 'declined',
          package: p.package,
          version: p.version,
          reason:
            'Cannot request user approval without an active session. Tell the user which package you wanted in prose and they can install it from Project → Settings.',
        });
      }
    } else {
      const question: Question = {
        id: randomUUID(),
        projectId: opts.projectId,
        gezelId: opts.gezelId ?? '',
        sessionId: opts.sessionId,
        prompt: buildApprovalPrompt(needsApproval),
        allowWriteIn: false,
        multiSelect: false,
        intent: { kind: 'npm-install-approval', packages: needsApproval },
        createdAt: new Date().toISOString(),
      };
      await opts.store.writeQuestion(question);
      // Surface the question as an SSE `question_asked` event so the
      // UI's PendingQuestionCard can pop up. Without this the question
      // exists on disk but the user never sees it — the gezel says
      // "I requested approval" and then the conversation hangs because
      // there's no card to click. Same pattern as image-gen.ts and
      // permissions.ts which also surface approval questions.
      opts.chatEvents?.publish(
        {
          sessionId: opts.sessionId,
          gezelId: opts.gezelId ?? '',
          projectId: opts.projectId,
        },
        { type: 'question_asked', question },
      );
      for (const p of needsApproval) {
        results.push({
          kind: 'pending-approval',
          questionId: question.id,
          package: p.package,
          version: p.version,
          deduped: false,
        });
      }
    }
  }

  return { results };
}

function buildApprovalPrompt(packages: NpmInstallApprovalPackage[]): string {
  if (packages.length === 1) {
    const p = packages[0]!;
    return `A gezel wants to install the npm package **${p.package}@${p.version}** — not in the pre-vetted list. Approve?`;
  }
  const lines = packages.map((p) => `- **${p.package}@${p.version}**`).join('\n');
  return `A gezel wants to install ${packages.length} npm packages — not in the pre-vetted list. Approve each?\n\n${lines}`;
}

function keyOf(pkg: string, version: string): string {
  return `${pkg}@${version}`;
}

function dedupRequests(raw: NpmInstallPackageRequest[]): NpmInstallApprovalPackage[] {
  const seen = new Set<string>();
  const out: NpmInstallApprovalPackage[] = [];
  for (const r of raw) {
    const pkg = NpmPackageNameSchema.parse(r.package);
    const version = NpmRegistryVersionSchema.parse(r.version ?? 'latest');
    const key = keyOf(pkg, version);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ package: pkg, version });
  }
  return out;
}

/**
 * Build a `(pkg@ver) → question` index across the project's pending
 * `npm-install-approval` questions. One pending question can cover
 * multiple packages, so we fan it out here.
 */
async function loadPendingApprovalIndex(
  store: Store,
  projectId: string,
): Promise<Map<string, Question>> {
  const index = new Map<string, Question>();
  const all = await store.listProjectQuestions(projectId);
  for (const q of all) {
    if (q.answer) continue;
    if (q.intent?.kind !== 'npm-install-approval') continue;
    for (const p of intentPackages(q.intent)) {
      const key = keyOf(p.package, p.version);
      if (!index.has(key)) index.set(key, q);
    }
  }
  return index;
}

async function installNow(
  store: Store,
  workspaceDir: string,
  pkg: string,
  version: string,
  projectId: string,
): Promise<NpmInstallPackageOutcome> {
  const spec =
    version === 'latest' || version === '*'
      ? formatNpmRegistrySpec(pkg)
      : formatNpmRegistrySpec(pkg, version);
  const res = await runPnpm(['add', '--', spec], { cwd: workspaceDir });
  if (!res.ok) {
    return {
      kind: 'failed',
      package: pkg,
      version,
      error: `pnpm add exited with code ${res.code ?? 'null'}`,
      stdout: res.stdout,
      stderr: res.stderr,
    };
  }
  await store.touchProject(projectId);
  return {
    kind: 'installed',
    package: pkg,
    version,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

/**
 * Called from the question-answer handler when a user submits per-package
 * decisions for an `npm-install-approval` question. Applies each decision
 * to the project allowlist, installs approved packages, and returns a
 * single follow-up message to deliver into the gezel's session.
 */
export async function applyNpmInstallApprovals(
  store: Store,
  home: string,
  projectId: string,
  decisions: NpmInstallApprovalDecision[],
): Promise<string> {
  if (decisions.length === 0) {
    return "[npm_install follow-up: user dismissed the approval without a decision. Don't retry; ask differently.]";
  }
  const allow = await readProjectAllowlist(home, projectId);
  const installed: string[] = [];
  const declined: string[] = [];
  const failed: Array<{ spec: string; error: string }> = [];
  // Route through the writability gate so we share one path with the
  // rest of the workspace-fs surface. Post the Phase-1 resolver
  // unification this is equivalent to `projectWorkspaceDir` for the dir
  // value, but it also surfaces a denial if the user has an external
  // external `workingDir` without managed-write consent — installing packages into
  // their folder without permission was a real footgun that this gate
  // closes for free.
  const gate = await store.assertWorkspaceWritable(projectId);
  if (!gate.ok) {
    return gate.reason === 'disabled-by-project'
      ? '[npm_install follow-up: workspace not writable (disabled-by-project). Gezel writes are turned off for this project in Project → Settings; packages cannot be installed until the user re-enables them.]'
      : `[npm_install follow-up: workspace not writable (${gate.reason}). The user's external workingDir needs managed workspace writes enabled before packages can be installed.]`;
  }
  const workspaceDir = gate.workspaceDir;

  for (const d of decisions) {
    const entry: AllowlistedEntry = {
      package: d.package,
      version: d.version,
      at: new Date().toISOString(),
      approvedBy: 'user',
    };
    if (d.decision === 'decline') {
      allow.declined = [
        ...allow.declined.filter((e) => !(e.package === d.package && e.version === d.version)),
        entry,
      ];
      declined.push(`${d.package}@${d.version}`);
      continue;
    }
    allow.approved = [
      ...allow.approved.filter((e) => !(e.package === d.package && e.version === d.version)),
      entry,
    ];
    const result = await installNow(store, workspaceDir, d.package, d.version, projectId);
    if (result.kind === 'installed') {
      installed.push(`${d.package}@${d.version}`);
    } else if (result.kind === 'failed') {
      failed.push({ spec: `${d.package}@${d.version}`, error: result.error });
    }
  }

  await writeProjectAllowlist(home, projectId, allow);

  const parts: string[] = [];
  if (installed.length > 0) parts.push(`installed ${installed.join(', ')}`);
  if (declined.length > 0) parts.push(`user declined ${declined.join(', ')}`);
  if (failed.length > 0) {
    parts.push(`install failed for ${failed.map((f) => `${f.spec} (${f.error})`).join(', ')}`);
  }
  const declinedImageGeneration = declined.some((spec) =>
    /\b(image|img|logo|generator|generation|stable|diffusion|sdxl|ai)\b/i.test(spec),
  );
  if (declinedImageGeneration) {
    parts.push(
      'use the built-in `generate_image` / `render_image` tool instead of installing image-generation packages',
    );
  }
  const body = parts.length > 0 ? parts.join('; ') : 'no changes';
  return `[npm_install follow-up: ${body}. You can now import any installed packages; do not retry declined ones.]`;
}
