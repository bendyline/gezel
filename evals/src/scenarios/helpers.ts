/**
 * Shared scenario plumbing.
 *
 * Three of our scenarios (tictactoe, petshop, tankcombat) had the same
 * shape: enumerate non-default projects → list HTML files across both
 * `workspace/` and `artifacts/` surfaces → read each → call a scenario-
 * specific sniff → log via `logChanged` with the now-canonical signals +
 * failReason line. Factoring the shape into one helper here means:
 *   - Adding a new HTML-deliverable scenario is "implement the sniff
 *     function, hand it to `pollHtmlSniff`."
 *   - Log line formatting stays consistent across scenarios (the
 *     `score-trial.ts` parser depends on it).
 *   - Surface-listing behavior (workspace + artifacts both checked,
 *     missing surfaces tolerated) lives in exactly one place.
 *
 * The helper is intentionally narrow: it expects an HTML-shape sniff
 * (`{ ok, signals, score, failReason? }`). Scenarios with different
 * deliverable shapes (e.g. tool-routing-image looks for PNGs) stay
 * inline — premature generalization would force them through the wrong
 * lens.
 */

import { createHash } from 'node:crypto';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { type RuntimeAssertion, type RuntimeReport, renderAndAssert } from '../html-validation.ts';
import { postRuntimeFeedback } from '../runtime-feedback.ts';
import {
  type MissingDeliverableFeedbackOptions,
  type MissingDeliverableNearMiss,
  type SniffFeedbackOptions,
  postMissingDeliverableFeedback,
  postSniffFeedback,
} from '../sniff-feedback.ts';
import type { SniffResult } from '../success-check.ts';
import type { EvalContext, SuccessCheckResult } from '../types.ts';

export type { RuntimeAssertion };

export interface ProvisionedScenarioGezel {
  id: string;
  name: string;
}

export interface ProvisionScenarioGezelOptions {
  /** Human-friendly deterministic name used by the scenario prompt. */
  preferredName: string;
  /** Product role whose shipped template should shape the gezel. */
  role: string;
  /** Lowercase noun used only in setup logs (for example, "developer"). */
  label?: string;
}

/** Mirror `Store`'s gezel-id slug rule so setup can avoid a destructive create collision. */
function scenarioGezelIdForName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function sameScenarioRole(actual: string | null | undefined, expected: string): boolean {
  return actual?.trim().toLowerCase() === expected.trim().toLowerCase();
}

function collisionSafeScenarioName(preferredName: string, role: string, attempt: number): string {
  if (attempt === 0) return preferredName;
  if (attempt === 1) return `${preferredName} (${role})`;
  // Keep the numeric discriminator before Store's 64-character id cap.
  return `${preferredName.slice(0, 36)} (${role.slice(0, 18)} ${attempt})`;
}

/**
 * Create or reuse a deterministic scenario specialist without ever reusing
 * the active Meester. `Store.createGezel` derives the id directly from the
 * name and currently overwrites an existing same-id directory, so calling it
 * with a randomized Meester's name can silently turn the only coordinator
 * into the specialist. This helper checks both display-name and derived-id
 * collisions first, then chooses a stable role-suffixed fallback.
 */
export async function provisionScenarioGezel(
  ctx: Pick<EvalContext, 'client' | 'meesterId' | 'log'>,
  opts: ProvisionScenarioGezelOptions,
): Promise<ProvisionedScenarioGezel> {
  const { client, meesterId, log } = ctx;
  const label = opts.label ?? opts.role.toLowerCase();
  let { gezels } = await client.listGezels();

  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidateName = collisionSafeScenarioName(opts.preferredName, opts.role, attempt);
    const candidateId = scenarioGezelIdForName(candidateName);
    const sameName = gezels.find(
      (gezel) => gezel.name.trim().toLowerCase() === candidateName.trim().toLowerCase(),
    );
    const sameId = gezels.find((gezel) => gezel.id === candidateId);
    const existing = sameName ?? sameId;

    if (existing) {
      if (sameName && existing.id !== meesterId && sameScenarioRole(existing.role, opts.role)) {
        log(
          `[scenario:setup] reusing ${label} "${existing.name}" id=${existing.id}${attempt > 0 ? ` (collision-safe name for "${opts.preferredName}")` : ''}`,
        );
        return { id: existing.id, name: existing.name };
      }
      if (attempt === 0) {
        log(
          `[scenario:setup] preferred ${label} name "${opts.preferredName}" collides with ${existing.id === meesterId ? 'the active Meester' : `existing gezel ${existing.id}`}; choosing a collision-safe name`,
        );
      }
      continue;
    }

    try {
      const created = await client.createGezel({ name: candidateName, role: opts.role });
      // Defensive postcondition for an unexpected service-side slug-rule drift.
      if (created.id === meesterId || gezels.some((gezel) => gezel.id === created.id)) {
        throw new Error(
          `scenario gezel provisioning collision: create(${JSON.stringify(candidateName)}) returned occupied id ${created.id}`,
        );
      }
      log(
        `[scenario:setup] created ${label} "${created.name}" id=${created.id}${attempt > 0 ? ` (preferred "${opts.preferredName}" was occupied)` : ''}`,
      );
      return { id: created.id, name: created.name };
    } catch (err) {
      // A concurrent/idempotent setup may have created this exact specialist
      // between list and create. Reuse only a role-compatible non-Meester;
      // every other error remains fatal.
      ({ gezels } = await client.listGezels());
      const raced = gezels.find(
        (gezel) =>
          gezel.name.trim().toLowerCase() === candidateName.trim().toLowerCase() &&
          gezel.id !== meesterId &&
          sameScenarioRole(gezel.role, opts.role),
      );
      if (raced) {
        log(`[scenario:setup] reusing ${label} "${raced.name}" id=${raced.id} after create race`);
        return { id: raced.id, name: raced.name };
      }
      throw err;
    }
  }

  throw new Error(
    `scenario gezel provisioning exhausted collision-safe names for "${opts.preferredName}" (${opts.role})`,
  );
}

/** Turn browser console/page errors into an actionable runtime assertion
 * failure. Previously `renderAndAssert` collected them but the poller only
 * looked at `report.failed`, so a page that threw on load could still pass
 * every scenario-specific DOM probe. */
export function runtimeReportForGate(report: RuntimeReport): RuntimeReport {
  if (!report.ran || report.pageErrors.length === 0) return report;
  if (report.failed.some((failure) => failure.name === 'no-page-errors')) return report;
  return {
    ...report,
    failed: [
      ...report.failed,
      {
        name: 'no-page-errors',
        why: `${report.pageErrors.length} browser error(s); first: ${report.pageErrors[0]?.slice(0, 240) ?? '(empty)'}`,
      },
    ],
  };
}

export interface ProjectFileRef {
  projectId: string;
  surface: 'artifacts' | 'workspace';
  filePath: string;
}

type DeliverableSurface = ProjectFileRef['surface'] | 'documents';

interface DeliverableNearMissCandidate {
  projectId?: string;
  surface?: DeliverableSurface;
  filePath: string;
  rooted: string;
}

/**
 * Enumerate all HTML files in a project's workspace + artifacts trees.
 * Both surfaces matter — voorman/developer templates write to
 * workspace/ via writeFile; create_artifact / write_artifact land
 * in artifacts/. The model picks based on its own template guidance.
 */
export async function listHtmlFiles(
  client: GezelClient,
  projectId: string,
): Promise<ProjectFileRef[]> {
  const out: ProjectFileRef[] = [];
  for (const surface of ['workspace', 'artifacts'] as const) {
    try {
      const list =
        surface === 'workspace'
          ? await client.listProjectWorkspace(projectId, undefined, true)
          : await client.listProjectArtifacts(projectId, undefined, true);
      for (const f of list.files) {
        if (f.isDirectory) continue;
        if (f.path.toLowerCase().endsWith('.html')) {
          out.push({ projectId, surface, filePath: f.path });
        }
      }
    } catch {
      // Empty / nonexistent surface — skip silently.
    }
  }
  return out;
}

/** Same enumeration but for arbitrary file types — used by petshop's image-asset check. */
export async function listAllFiles(
  client: GezelClient,
  projectId: string,
): Promise<Array<ProjectFileRef & { rooted: string }>> {
  const out: Array<ProjectFileRef & { rooted: string }> = [];
  for (const surface of ['workspace', 'artifacts'] as const) {
    try {
      const list =
        surface === 'workspace'
          ? await client.listProjectWorkspace(projectId, undefined, true)
          : await client.listProjectArtifacts(projectId, undefined, true);
      for (const f of list.files) {
        if (f.isDirectory) continue;
        out.push({
          projectId,
          surface,
          filePath: f.path,
          rooted: `${surface}/${f.path}`,
        });
      }
    } catch {
      // skip
    }
  }
  return out;
}

export async function readSurfaceText(client: GezelClient, ref: ProjectFileRef): Promise<string> {
  const blob =
    ref.surface === 'workspace'
      ? await client.fetchProjectWorkspaceBlob(ref.projectId, ref.filePath)
      : await client.fetchProjectArtifactBlob(ref.projectId, ref.filePath);
  return blob.text();
}

export function findNearMissDeliverable(
  files: DeliverableNearMissCandidate[],
  expectedPath: string,
  opts: { requiredSurface?: DeliverableSurface } = {},
): MissingDeliverableNearMiss | undefined {
  const expected = normalizeProjectPath(expectedPath);
  const requiredRooted = opts.requiredSurface ? `${opts.requiredSurface}/${expected}` : undefined;
  const expectedStem = basenameWithoutExtension(expected);
  if (!expectedStem) return undefined;

  const scored = files
    .filter((file) => {
      if (requiredRooted) return normalizeProjectPath(file.rooted) !== requiredRooted;
      return normalizeProjectPath(file.filePath) !== expected;
    })
    .map((file) => {
      const rooted = normalizeProjectPath(file.rooted);
      const normalizedPath = normalizeProjectPath(file.filePath);
      const base = basenameWithoutExtension(file.filePath);
      let score = 0;
      if (normalizedPath === expected) score += 10;
      if (rooted.endsWith(`/${expected}`)) score += 8;
      if (base.includes(expectedStem)) score += 5;
      if (rooted.includes(expectedStem)) score += 2;
      if (/(^|[\/_.-])(plan|draft|notes?|outline|analysis)([\/_.-]|$)/i.test(rooted)) score += 4;
      if (/\.(?:md|txt)$/i.test(file.filePath)) score += 1;
      return { file, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.file.rooted.localeCompare(b.file.rooted));

  const best = scored[0]?.file;
  if (!best) return undefined;
  return {
    path: best.filePath,
    location: best.rooted,
  };
}

export async function findWorkspaceDeliverableNearMiss(
  client: GezelClient,
  projectId: string,
  expectedPath: string,
): Promise<MissingDeliverableNearMiss | undefined> {
  const candidates: DeliverableNearMissCandidate[] = await listAllFiles(client, projectId);

  try {
    const { files } = await client.listDocuments(undefined, true);
    candidates.push(
      ...files
        .filter((file) => !file.isDirectory)
        .map((file) => ({
          surface: 'documents' as const,
          filePath: file.path,
          rooted: `documents/${file.path}`,
        })),
    );
  } catch {
    // Some write_document calls are surfaced reliably in history before
    // document listing/capture reflects them. Fall through to history.
  }

  try {
    const { entries } = await client.listHistory({
      projectId,
      kind: 'document.created',
      limit: 50,
    });
    const expected = normalizeProjectPath(expectedPath);
    for (const entry of entries) {
      if (entry.entryType !== 'event' || entry.kind !== 'document.created') continue;
      const details = entry.details as { path?: unknown } | undefined;
      const path = typeof details?.path === 'string' ? details.path : '';
      if (normalizeProjectPath(path) !== expected) continue;
      candidates.push({
        surface: 'documents',
        filePath: path,
        rooted: `documents/${path}`,
      });
    }
  } catch {
    // History is advisory for feedback only; never fail a scenario poll on it.
  }

  return findNearMissDeliverable(candidates, expectedPath, {
    requiredSurface: 'workspace',
  });
}

function normalizeProjectPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .toLowerCase();
}

function basenameWithoutExtension(path: string): string {
  const normalized = normalizeProjectPath(path);
  const base = normalized.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Drive the "scan every non-default project's HTML files → sniff each →
 * log → return on first pass" loop the three game scenarios share.
 *
 * `sniff` is the scenario-specific content check (e.g.
 * `ticTacToeContentSniff`). The wrapper handles default-project
 * skipping, surface enumeration, log formatting (which `score-trial.ts`
 * parses), and the early-return on success.
 *
 * `extraSniffContext` is an optional hook for scenarios like petshop
 * that need extra context (the html's own path, plus the full project
 * file list) — return null from `getExtraContext` and `extraSniffContext`
 * stays unset on the call.
 */
export async function pollHtmlSniff<TExtra>(opts: {
  ctx: EvalContext;
  sniff: (html: string, extra: TExtra) => SniffResult;
  /**
   * Build whatever extra context the sniff needs. Called once per HTML
   * candidate after `listHtmlFiles` runs. For sniffs that don't need
   * extra context, pass `() => undefined as TExtra` (and ignore the
   * argument in your sniff).
   */
  getExtraContext: (
    client: GezelClient,
    ref: ProjectFileRef,
    project: { id: string },
  ) => Promise<TExtra>;
  /**
   * Optional runtime-assertion layer. When provided, the helper runs
   * Playwright over the HTML *after* the static sniff says `ok`. If
   * the runtime check also passes, the trial succeeds; if not, we
   * keep polling so the model has a chance to iterate. Skipped on
   * `done: false` from the sniff to avoid a Chromium boot per 5s
   * poll. Set this only on scenarios where the DOM has a check that's
   * cheap to express (tic-tac-toe cells; tank-combat canvas presence).
   */
  runtimeAssertions?: (html: string, extra: TExtra) => readonly RuntimeAssertion[];
  /**
   * Whether to fail the trial when the runtime check has *any* failed
   * assertion. Default false: any failed runtime assertion only logs
   * and keeps polling, since a small model may iterate. Set to `true`
   * for scenarios where a runtime miss is definitive (the file looks
   * right but doesn't actually run).
   */
  requireRuntime?: boolean;
  /**
   * Workspace path to demand when a non-default project exists but no
   * HTML candidate has been written yet.
   */
  missingDeliverablePath?: string;
  missingDeliverableFeedback?: MissingDeliverableFeedbackOptions;
  /**
   * Optional per-candidate context for sniff-failure nudges. Petshop uses
   * this to pass image src values that are known to resolve from the
   * current HTML file.
   */
  sniffFeedback?: (
    extra: TExtra,
    ref: ProjectFileRef,
    project: { id: string },
    html: string,
    sniff: SniffResult,
  ) => SniffFeedbackOptions | undefined;
}): Promise<SuccessCheckResult> {
  const { client, logChanged, recordSniff } = opts.ctx;
  const { projects } = await client.listProjects();
  const scopedProjects = projects.filter((project) => project.id !== 'default');
  const projectCandidates: Array<{
    project: { id: string };
    candidates: ProjectFileRef[];
  }> = [];

  for (const project of scopedProjects) {
    projectCandidates.push({
      project,
      candidates: await listHtmlFiles(client, project.id),
    });
  }
  const hasAnyHtmlCandidate = projectCandidates.some((entry) => entry.candidates.length > 0);

  // Substantive work belongs in a dedicated project. Finding output in
  // the default project means the Meester punted on orchestration, which
  // the eval shouldn't reward.
  for (const { project, candidates } of projectCandidates) {
    if (!hasAnyHtmlCandidate && candidates.length === 0 && opts.missingDeliverablePath) {
      const files = await listAllFiles(client, project.id);
      const nearMiss = findNearMissDeliverable(files, opts.missingDeliverablePath);
      await postMissingDeliverableFeedback(opts.ctx, opts.missingDeliverablePath, {
        ...opts.missingDeliverableFeedback,
        nearMiss,
        projectId: project.id,
      });
    }
    for (const ref of candidates) {
      const text = await readSurfaceText(client, ref);
      if (opts.missingDeliverablePath && ref.filePath !== opts.missingDeliverablePath) {
        await postMissingDeliverableFeedback(opts.ctx, opts.missingDeliverablePath, {
          ...opts.missingDeliverableFeedback,
          nearMiss: {
            path: ref.filePath,
            location: `${ref.surface}/${ref.filePath}`,
            bytes: text.length,
          },
          projectId: project.id,
        });
        continue;
      }
      const extra = await opts.getExtraContext(client, ref, project);
      const sniff = opts.sniff(text, extra);
      const key = `${ref.projectId}/${ref.surface}/${ref.filePath}`;
      const reasonSuffix = sniff.failReason ? ` failReason="${sniff.failReason}"` : '';
      const scoreText =
        sniff.scoreMax !== undefined ? `${sniff.score}/${sniff.scoreMax}` : `${sniff.score}`;
      logChanged(
        key,
        `[scenario] ${key} bytes=${text.length} score=${scoreText} signals=${sniff.signals.join(',') || 'none'}${reasonSuffix}`,
      );
      // Surface the sniff state up to the runner so its progress
      // fingerprint sees it. Without this, the runner's `latestSniff`
      // stays `null` for game scenarios and the retry-loop guard
      // can't tell whether the team is iterating productively (new
      // sniff scores) or stuck rewriting the same shape. The copilot
      // tankcombat trial died because of exactly this:
      // sniff plateaued at 8/8 with runtime failing, but the runner's
      // latestSniff stayed null → retry-loop guard never armed.
      recordSniff?.({ key, score: sniff.score, bytes: text.length, failReason: sniff.failReason });
      if (!sniff.ok) {
        // Sniff rejected the artifact. Surface the specific missing
        // signals + failReason into the chat so the model has something
        // to act on — without this, sniff-only scenarios (petshop) keep
        // polling silently while the model thinks it's done.
        // `postSniffFeedback` dedups by (filePath, missing-set,
        // failReason) so the 5-s poll doesn't spam.
        const sniffFeedback = opts.sniffFeedback?.(extra, ref, project, text, sniff) ?? {};
        await postSniffFeedback(opts.ctx, ref.filePath, sniff, {
          ...sniffFeedback,
          projectId: sniffFeedback.projectId ?? project.id,
          sourceText: text,
        });
        continue;
      }

      // Sniff passed. If a runtime layer is configured, run it before
      // declaring success — the page LOOKS like a tic-tac-toe, but
      // does it actually click? Failing runtime keeps the trial open
      // (model may fix on next iteration), unless requireRuntime=true.
      if (opts.runtimeAssertions) {
        const assertions = opts.runtimeAssertions(text, extra);
        const report = runtimeReportForGate(await renderAndAssert(text, assertions));
        const runtimeKey = `${key}#runtime`;
        logChanged(runtimeKey, formatRuntimeReport(key, report));
        // Re-record the sniff state WITH runtime pass/fail counts so
        // the runner's retry-loop watchdog can see runtime iteration
        // as movement. Without this the watchdog only sees the static
        // sniff (which stays at full score once it passes) and falsely
        // concludes the team is stuck. See `EvalContext.recordSniff`
        // for the wild-caught case (nemotron-super v5).
        recordSniff?.({
          key,
          score: sniff.score,
          bytes: text.length,
          failReason: sniff.failReason,
          runtimePassed: report.ran ? report.passed.length : 0,
          runtimeFailed: report.ran ? report.failed.length : 0,
        });
        if (!report.ran) {
          // Chromium couldn't boot — treat as advisory; don't fail the
          // trial for a Playwright infra issue.
          opts.ctx.log(
            `[scenario] runtime check skipped for ${key} (bootstrapError="${report.bootstrapError ?? 'unknown'}")`,
          );
          return {
            done: true,
            success: true,
            reason: `${ref.projectId}/${ref.surface}/${ref.filePath} passed sniff; runtime layer unavailable`,
          };
        }
        if (report.failed.length > 0 && opts.requireRuntime !== false) {
          // Runtime check failed in a meaningful way. Keep polling
          // (don't terminate the trial) so the model can self-correct,
          // but DON'T return success yet — a half-working page isn't
          // shippable. Surface the failure into chat so the model
          // actually has something to act on. Passing `text` (the
          // current file content) so the dedup detects "model
          // rewrote the file but the same assertion still fails"
          // and posts a fresh, escalating nudge instead of staying
          // silent. See runtime-feedback.ts for the escalation tiers.
          await postRuntimeFeedback(opts.ctx, ref.filePath, report, text, {
            projectId: project.id,
          });
          continue;
        }
        return {
          done: true,
          success: true,
          reason: `${ref.projectId}/${ref.surface}/${ref.filePath} passed sniff (signals: ${sniff.signals.join(', ')}) + runtime (${report.passed.length} assertion(s))`,
        };
      }

      return {
        done: true,
        success: true,
        reason: `${ref.projectId}/${ref.surface}/${ref.filePath} passed sniff (signals: ${sniff.signals.join(', ')})`,
      };
    }
  }
  return { done: false };
}

// ─────────────────────────────────────────────────────────────────────
// External-process helpers — used by scenarios that need to shell out
// to a real compiler / linter / mock server from successCheck (the new
// schema-migration / bookstore-openapi scenarios). Mirrors the
// Chromium-cleanup pattern in renderAndAssert: every spawn must
// finally-kill if it overruns or is interrupted.

export interface SpawnAwaitResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** True iff the process was killed because timeoutMs was exceeded. */
  timedOut: boolean;
}

/**
 * Spawn a child process to completion (or timeout) and capture
 * stdout/stderr. Used from `successCheck` to invoke external tools like
 * `npx tsc --noEmit`, `npx @redocly/cli lint`, or `node contract-test.mjs`.
 *
 * Output is truncated at `maxOutputBytes` per stream (default 32 KB) so a
 * pathological tool can't blow the trial process's heap. On timeout the
 * process is sent SIGTERM, then SIGKILL after a 2 s grace.
 *
 * Returns `{ exitCode, signal, stdout, stderr, durationMs, timedOut }`.
 * Callers check `exitCode === 0` for success.
 */
/**
 * Copy a project's workspace files into a local directory so graders can
 * run real tools (node, tsc, vitest) against the model's actual output.
 * `include` filters by path (default: everything). Used by every
 * runtime-gated scenario; keep behavior changes backward-compatible.
 */
export async function materializeProjectWorkspace(
  client: GezelClient,
  projectId: string,
  destDir: string,
  opts?: { include?: RegExp },
): Promise<number> {
  const { mkdir: mkdirP, writeFile: writeFileP } = await import('node:fs/promises');
  const { dirname: dirnameP, join: joinP } = await import('node:path');
  const files = await client.listProjectWorkspace(projectId, undefined, true);
  let count = 0;
  for (const f of files.files) {
    if (f.isDirectory) continue;
    if (/(^|\/)node_modules\//.test(f.path)) continue;
    if (opts?.include) {
      opts.include.lastIndex = 0;
      if (!opts.include.test(f.path)) continue;
    }
    const blob = await client.fetchProjectWorkspaceBlob(projectId, f.path);
    const content = await blob.text();
    const target = joinP(destDir, f.path);
    await mkdirP(dirnameP(target), { recursive: true });
    await writeFileP(target, content, 'utf8');
    count += 1;
  }
  return count;
}

/**
 * Full-content revision for every matching workspace file. Runtime-gate
 * caches must include transitive helper modules, configs, and newly-created
 * sources—not only the nominal entry file—or a model can edit an imported
 * helper while the grader keeps replaying a stale failure forever.
 */
export async function workspaceContentRevision(
  client: GezelClient,
  projectId: string,
  include: RegExp,
): Promise<string> {
  const { files } = await client.listProjectWorkspace(projectId, undefined, true);
  const paths = files
    .filter((file) => {
      if (file.isDirectory) return false;
      if (/(^|\/)node_modules\//.test(file.path)) return false;
      include.lastIndex = 0;
      return include.test(file.path);
    })
    .map((file) => file.path)
    .sort((a, b) => a.localeCompare(b));

  const hash = createHash('sha256');
  let chars = 0;
  const absorb = (text: string) => {
    chars += text.length;
    hash.update(text, 'utf8');
  };
  for (const path of paths) {
    const blob = await client.fetchProjectWorkspaceBlob(projectId, path);
    const content = await blob.text();
    absorb(path);
    absorb('\0');
    absorb(content);
    absorb('\0');
  }
  return `${hash.digest('hex')}.${chars.toString(36)}.${paths.length.toString(36)}`;
}

export async function spawnAndAwait(
  cmd: string,
  args: readonly string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /** Default 60 s. */
    timeoutMs?: number;
    /** Default 32 * 1024 per stream. */
    maxOutputBytes?: number;
  } = {},
): Promise<SpawnAwaitResult> {
  const { spawn } = await import('node:child_process');
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxOut = opts.maxOutputBytes ?? 32 * 1024;
  const startedAt = Date.now();
  const child = spawn(cmd, [...args], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdoutBuf = '';
  let stderrBuf = '';
  const appendCapped = (sink: 'out' | 'err', chunk: string) => {
    if (sink === 'out') {
      if (stdoutBuf.length >= maxOut) return;
      const room = maxOut - stdoutBuf.length;
      stdoutBuf += chunk.length > room ? chunk.slice(0, room) : chunk;
    } else {
      if (stderrBuf.length >= maxOut) return;
      const room = maxOut - stderrBuf.length;
      stderrBuf += chunk.length > room ? chunk.slice(0, room) : chunk;
    }
  };
  child.stdout?.on('data', (b: Buffer) => appendCapped('out', b.toString('utf8')));
  child.stderr?.on('data', (b: Buffer) => appendCapped('err', b.toString('utf8')));

  let timedOut = false;
  let killTimer: NodeJS.Timeout | undefined;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill('SIGTERM');
    } catch {}
    // SIGKILL grace — if the child ignores SIGTERM for 2 s, finalize it.
    killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
    }, 2_000);
  }, timeoutMs);

  try {
    const result: { code: number | null; signal: NodeJS.Signals | null } = await new Promise(
      (resolve) => {
        child.on('exit', (code, signal) => resolve({ code, signal }));
        child.on('error', () => resolve({ code: null, signal: null }));
      },
    );
    return {
      exitCode: result.code,
      signal: result.signal,
      stdout: stdoutBuf,
      stderr: stderrBuf,
      durationMs: Date.now() - startedAt,
      timedOut,
    };
  } finally {
    clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);
  }
}

function formatRuntimeReport(key: string, report: RuntimeReport): string {
  if (!report.ran) {
    return `[scenario] ${key}#runtime BOOTSTRAP_FAIL "${report.bootstrapError ?? 'unknown'}"`;
  }
  const failedSummary = report.failed.map((f) => `${f.name}="${f.why.slice(0, 80)}"`).join(' | ');
  return `[scenario] ${key}#runtime passed=${report.passed.length} failed=${report.failed.length}${failedSummary ? ` failures: ${failedSummary}` : ''}${report.pageErrors.length ? ` pageErrors=${report.pageErrors.length}` : ''}`;
}
