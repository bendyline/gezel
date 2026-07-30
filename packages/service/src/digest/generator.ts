import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ChatSessionSummary,
  type GezelDetail,
  type HistoryEvent,
  type Project,
  type ProviderName,
  createLogger,
  isProactiveAllowed,
} from '@bendyline/gezel';
import { projectLocalDir } from '@bendyline/gezel/paths';
import type { ChatEventBus } from '../chat/events.js';
import { writeFileAtomic } from '../fs/atomic.js';
import type { Store } from '../fs/store.js';
import { resolveProjectBoekwachter } from '../gezels/autonomous-roles.js';
import { runGit } from '../git/git.js';
import { inspectGitWorkdir } from '../git/inspect.js';
import type { HistoryManager } from '../history/manager.js';
import { resolveEnrichTarget } from '../index-store/enrich.js';

/**
 * Weekly "what changed" digest per project — the temporal deep pass. Sources
 * the last seven days of commits (any git workingDir, GitHub-linked or not),
 * history events, and chat-session activity, asks the project's Boekwachter for a short
 * narrative, and lands it in the artifacts drawer under reports/ where both
 * the user and gezels can read it.
 *
 * Same lifecycle discipline as MemoryCompactor: daily unref'd sweep, gated by
 * config + proactive engagement, idempotent via an input hash in a per-project
 * state file — an unchanged week never burns a second LLM call.
 */

const log = createLogger('digest');

const STARTUP_DELAY_MS = 15 * 60_000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60_000;
const WINDOW_MS = 7 * 24 * 60 * 60_000;
const MAX_COMMITS = 100;
const MAX_EVENTS = 200;
const MAX_SESSIONS = 50;
const MIN_EVENTS_FOR_DIGEST = 3;
const PROMPT_INPUT_CAP = 12_000;
const ONE_SHOT_TIMEOUT_MS = 180_000;

export type DigestOneShot = (
  prompt: string,
  timeoutMs: number,
  opts: {
    gezelId: string;
    useGezelPersona: boolean;
    actorLabel: string;
    providerName: ProviderName;
    model: string;
    jobLabel: string;
  },
) => Promise<string>;

interface DigestState {
  lastWeek?: string;
  inputHash?: string;
  lastRunAt?: string;
}

export interface DigestSweepResult {
  projects: number;
  generated: number;
  skipped: number;
}

export interface ProjectDigestGeneratorOptions {
  store: Store;
  history: HistoryManager;
  oneShot: DigestOneShot;
  intervalMs?: number;
  startupDelayMs?: number;
  now?: () => Date;
  /** Wired to the indexing job task's pause switch, like enrichment. */
  isPaused?: () => Promise<boolean> | boolean;
  /**
   * Live-chat admission gate. Weekly digests are optional maintenance and
   * must yield whenever an interactive session is running or queued.
   */
  isChatActive?: () => boolean;
  /** Called after a sweep that generated at least one digest — the indexing
   *  job task appends it as a progress note. */
  onSweep?: (result: DigestSweepResult) => void;
  /** Chat event bus for `index_progress` heartbeats (optional in tests). */
  events?: Pick<ChatEventBus, 'publishGlobalEvent'>;
  /** Test seam; production resolves roster membership for each project. */
  resolveBoekwachter?: (projectId: string) => Promise<GezelDetail | null>;
}

export class ProjectDigestGenerator {
  private readonly store: Store;
  private readonly history: HistoryManager;
  private readonly oneShot: DigestOneShot;
  private readonly intervalMs: number;
  private readonly startupDelayMs: number;
  private readonly now: () => Date;
  private readonly isPaused: () => Promise<boolean> | boolean;
  private readonly isChatActive: () => boolean;

  private readonly onSweep?: (result: DigestSweepResult) => void;
  private readonly events: Pick<ChatEventBus, 'publishGlobalEvent'> | undefined;
  private readonly resolveBoekwachter: (projectId: string) => Promise<GezelDetail | null>;

  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(opts: ProjectDigestGeneratorOptions) {
    this.store = opts.store;
    this.history = opts.history;
    this.oneShot = opts.oneShot;
    this.intervalMs = opts.intervalMs ?? SWEEP_INTERVAL_MS;
    this.startupDelayMs = opts.startupDelayMs ?? STARTUP_DELAY_MS;
    this.now = opts.now ?? (() => new Date());
    this.isPaused = opts.isPaused ?? (() => false);
    this.isChatActive = opts.isChatActive ?? (() => false);
    this.onSweep = opts.onSweep;
    this.events = opts.events;
    this.resolveBoekwachter =
      opts.resolveBoekwachter ??
      ((projectId) => resolveProjectBoekwachter(this.store, projectId).catch(() => null));
  }

  start(): void {
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.sweep().catch((err) => log.warn(`startup sweep failed: ${describe(err)}`));
    }, this.startupDelayMs);
    unref(this.startupTimer);
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((err) => log.warn(`sweep failed: ${describe(err)}`));
    }, this.intervalMs);
    unref(this.sweepTimer);
  }

  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.startupTimer = null;
    this.sweepTimer = null;
  }

  /** Exposed for tests: one full pass over every project. */
  async sweep(): Promise<DigestSweepResult> {
    const result: DigestSweepResult = { projects: 0, generated: 0, skipped: 0 };
    if (this.sweeping) return result;
    this.sweeping = true;
    try {
      const config = await this.store.readConfig().catch(() => null);
      if (!config || config.digest?.enabled === false) return result;
      if (!isProactiveAllowed(config)) return result;
      if (await this.isPaused()) return result;
      if (this.isChatActive()) {
        log.debug('digest sweep deferred while live chat is active');
        return result;
      }
      const projects = await this.store.listProjects().catch(() => []);
      for (const project of projects) {
        // A user turn may arrive after the sweep's initial gate while git,
        // history, and session inputs are being collected. Yield before each
        // project so optional digest work never piles onto fresh foreground
        // activity.
        if (this.isChatActive()) {
          log.debug('digest sweep yielded to newly active live chat');
          break;
        }
        const boekwachter = await this.resolveBoekwachter(project.id);
        if (!boekwachter) continue;
        result.projects++;
        try {
          const generated = await this.generateForProject(project, boekwachter);
          if (generated) result.generated++;
          else result.skipped++;
        } catch (err) {
          result.skipped++;
          log.warn(`digest for ${project.id} failed: ${describe(err)}`);
        }
      }
      if (result.generated > 0) this.onSweep?.(result);
      return result;
    } finally {
      this.sweeping = false;
    }
  }

  private async generateForProject(project: Project, boekwachter: GezelDetail): Promise<boolean> {
    const now = this.now();
    const week = isoWeek(now);
    const from = new Date(now.getTime() - WINDOW_MS).toISOString();

    const [rawEvents, allSessions, commits] = await Promise.all([
      this.history
        .listEvents({ projectId: project.id, from, limit: MAX_EVENTS })
        .catch(() => [] as HistoryEvent[]),
      this.store.listSessions({ projectId: project.id }).catch(() => [] as ChatSessionSummary[]),
      this.collectCommits(project.id, from),
    ]);
    // Our own generation events must not feed the input hash, or every digest
    // would invalidate itself and regenerate on the next sweep.
    const events = rawEvents.filter((e) => e.kind !== 'project.digest.generated');
    const sessions = allSessions.filter((s) => s.lastActivityAt >= from).slice(0, MAX_SESSIONS);

    // A quiet week produces no digest at all — silence over noise.
    if (commits.length === 0 && sessions.length === 0 && events.length < MIN_EVENTS_FOR_DIGEST) {
      return false;
    }

    const inputHash = createHash('sha256')
      .update(
        [
          week,
          ...commits,
          ...events.map((e) => e.id),
          ...sessions.map((s) => `${s.id}:${s.lastActivityAt}`),
        ].join('\n'),
      )
      .digest('hex');
    const state = await this.readState(project.id);
    if (state.lastWeek === week && state.inputHash === inputHash) return false;

    // Re-check at the expensive boundary. Input collection can take long
    // enough for a foreground turn to start after sweep admission.
    if (this.isChatActive()) {
      log.debug(`digest for ${project.id} deferred before model completion`);
      return false;
    }

    const target = await resolveEnrichTarget(this.store, { boekwachter });
    if (!target) return false;
    const prompt = buildDigestPrompt(project.name, week, commits, events, sessions);
    const narrative = (
      await this.oneShot(prompt, ONE_SHOT_TIMEOUT_MS, {
        gezelId: boekwachter.id,
        useGezelPersona: true,
        actorLabel: boekwachter.name,
        providerName: target.providerName,
        model: target.model,
        jobLabel: `weekly digest · ${project.name}`,
      })
    ).trim();
    if (!narrative) return false;

    const artifactPath = `reports/digest-${week}.md`;
    await this.store.writeProjectArtifact(
      project.id,
      artifactPath,
      renderDigestMarkdown(project.name, week, narrative, commits, events, sessions),
    );
    await this.history.log({
      kind: 'project.digest.generated',
      projectId: project.id,
      summary: `Weekly digest ${week} generated for "${project.name}"`,
      details: {
        week,
        path: artifactPath,
        commits: commits.length,
        events: events.length,
        sessions: sessions.length,
      },
    });
    await this.writeState(project.id, {
      lastWeek: week,
      inputHash,
      lastRunAt: now.toISOString(),
    });
    log.info(`digest ${week} written for ${project.id} (${commits.length} commits)`);
    this.events?.publishGlobalEvent({
      type: 'index_progress',
      phase: 'digest',
      state: 'ended',
      projectId: project.id,
      detail: `weekly digest ${week}`,
      gezelId: boekwachter.id,
      gezelName: boekwachter.name,
    });
    return true;
  }

  /** `git log --since` against the project's workingDir when it's a repo —
   *  works for plain local repos, not just GitHub-linked projects. */
  private async collectCommits(projectId: string, fromIso: string): Promise<string[]> {
    try {
      const dir = await this.store.projectWorkspaceDir(projectId);
      const inspected = await inspectGitWorkdir(dir);
      if (!inspected.isRepo) return [];
      const res = await runGit(
        [
          'log',
          `--since=${fromIso}`,
          '--no-merges',
          '--date=short',
          '--pretty=format:%h %ad %s',
          `--max-count=${MAX_COMMITS}`,
        ],
        { cwd: dir, timeoutMs: 15_000 },
      );
      return res.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private stateFile(projectId: string): string {
    return join(projectLocalDir(this.store.homePath, projectId), 'digest-state.json');
  }

  private async readState(projectId: string): Promise<DigestState> {
    try {
      return JSON.parse(await readFile(this.stateFile(projectId), 'utf8')) as DigestState;
    } catch {
      return {};
    }
  }

  private async writeState(projectId: string, state: DigestState): Promise<void> {
    await writeFileAtomic(this.stateFile(projectId), `${JSON.stringify(state, null, 2)}\n`);
  }
}

/** ISO-8601 week label, e.g. `2026-W27`. */
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function buildDigestPrompt(
  projectName: string,
  week: string,
  commits: string[],
  events: HistoryEvent[],
  sessions: ChatSessionSummary[],
): string {
  const sections: string[] = [];
  if (commits.length > 0) {
    sections.push(`## Commits (${commits.length})\n${commits.join('\n')}`);
  }
  if (events.length > 0) {
    const byKind = new Map<string, number>();
    for (const e of events) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
    const counts = [...byKind.entries()].map(([k, n]) => `${k}: ${n}`).join(', ');
    const lines = events.slice(0, 40).map((e) => `- ${e.at.slice(0, 10)} ${e.summary}`);
    sections.push(`## Activity events (${counts})\n${lines.join('\n')}`);
  }
  if (sessions.length > 0) {
    const lines = sessions.map((s) => `- ${s.lastActivityAt.slice(0, 10)} ${s.title}`);
    sections.push(`## Chat sessions (${sessions.length})\n${lines.join('\n')}`);
  }
  const input = sections.join('\n\n').slice(0, PROMPT_INPUT_CAP);
  return `You are writing the weekly digest for the project "${projectName}" (${week}). Below is the raw activity from the last seven days.

${input}

Write 2-4 short paragraphs of plain prose for the project owner: what actually changed, what the crew worked on, and anything that looks unfinished or worth attention next week. Ground every statement in the activity above — no speculation, no headings, no bullet lists.`;
}

function renderDigestMarkdown(
  projectName: string,
  week: string,
  narrative: string,
  commits: string[],
  events: HistoryEvent[],
  sessions: ChatSessionSummary[],
): string {
  const parts = [
    `# ${projectName} — week ${week}`,
    '',
    narrative,
    '',
    `_${commits.length} commits · ${events.length} events · ${sessions.length} sessions_`,
  ];
  if (commits.length > 0) {
    parts.push('', '## Commits', '', ...commits.map((c) => `- ${c}`));
  }
  return `${parts.join('\n')}\n`;
}

function unref(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
