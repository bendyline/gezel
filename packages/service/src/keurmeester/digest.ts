import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KeurmeesterCaseOpened, KeurmeesterCaseRecord, ProviderName } from '@bendyline/gezel';
import {
  ProviderNameSchema,
  createLogger,
  isLocalProvider,
  isProactiveAllowed,
} from '@bendyline/gezel';
import { keurmeesterDigestStatePath, keurmeesterDigestsDir } from '@bendyline/gezel/paths';
import { writeFileAtomic } from '../fs/atomic.js';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import { KeurmeesterCaseStore } from './case-store.js';

/**
 * The debug/learning harvest: aggregates Keurmeester intervention case
 * records into a daily findings digest — which models fail where, which
 * interventions stick, which tasks/craftbooks are repeat offenders —
 * plus an optional frontier-authored "systemic recommendations" section
 * proposing craftbook/behavior changes (recommendations only, never
 * auto-applied; same contract as the night-shift oversight review).
 *
 * Same lifecycle discipline as ProjectDigestGenerator: daily unref'd
 * sweep, gated by config + proactive engagement, idempotent via a state
 * file — a day with no new cases never writes a digest or burns an LLM
 * call. Output lands at `~/.gezel/keurmeester/digests/YYYY-MM-DD.md`
 * (the KeurmeesterManager's carve-out — see AGENTS.md).
 */

const log = createLogger('keurmeester');

const STARTUP_DELAY_MS = 20 * 60_000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60_000;
const ONE_SHOT_TIMEOUT_MS = 180_000;
const PROMPT_INPUT_CAP = 14_000;

export type KeurmeesterDigestOneShot = (
  prompt: string,
  timeoutMs: number,
  opts: {
    providerName?: ProviderName;
    model?: string;
    useKeurmeester?: boolean;
    jobLabel?: string;
  },
) => Promise<string>;

interface KeurmeesterDigestState {
  /** ISO timestamp of the newest case folded into the last digest. */
  lastCaseTs?: string;
  lastRunAt?: string;
}

export interface KeurmeesterDigestGeneratorOptions {
  store: Store;
  history: HistoryManager;
  oneShot: KeurmeesterDigestOneShot;
  home: string;
  intervalMs?: number;
  startupDelayMs?: number;
  now?: () => Date;
}

export class KeurmeesterDigestGenerator {
  private readonly store: Store;
  private readonly history: HistoryManager;
  private readonly oneShot: KeurmeesterDigestOneShot;
  private readonly home: string;
  private readonly cases: KeurmeesterCaseStore;
  private readonly intervalMs: number;
  private readonly startupDelayMs: number;
  private readonly now: () => Date;

  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(opts: KeurmeesterDigestGeneratorOptions) {
    this.store = opts.store;
    this.history = opts.history;
    this.oneShot = opts.oneShot;
    this.home = opts.home;
    this.cases = new KeurmeesterCaseStore(opts.home);
    this.intervalMs = opts.intervalMs ?? SWEEP_INTERVAL_MS;
    this.startupDelayMs = opts.startupDelayMs ?? STARTUP_DELAY_MS;
    this.now = opts.now ?? (() => new Date());
  }

  start(): void {
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.sweep().catch((err) => log.warn(`digest startup sweep failed: ${describe(err)}`));
    }, this.startupDelayMs);
    this.startupTimer.unref?.();
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((err) => log.warn(`digest sweep failed: ${describe(err)}`));
    }, this.intervalMs);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.startupTimer = null;
    this.sweepTimer = null;
  }

  /** Exposed for tests: one digest pass. Returns true when a digest was written. */
  async sweep(): Promise<boolean> {
    if (this.sweeping) return false;
    this.sweeping = true;
    try {
      const config = await this.store.readConfig().catch(() => null);
      if (!config) return false;
      // The harvest exists for supervision users and for dev/debug work
      // on gezel itself — debugMode alone is enough to keep the loop
      // running while iterating even if supervision was toggled off.
      if (config.keurmeester?.enabled !== true && config.debugMode !== true) return false;
      if (!isProactiveAllowed(config)) return false;

      const state = await this.readState();
      const records = await this.cases.read(state.lastCaseTs);
      // Records at exactly lastCaseTs were already digested (read() is >=).
      const fresh = state.lastCaseTs
        ? records.filter((r) => r.ts > (state.lastCaseTs as string))
        : records;
      if (fresh.length === 0) return false;
      const opened = fresh.filter((r): r is KeurmeesterCaseOpened => r.record === 'case.opened');
      if (opened.length === 0) return false;

      const now = this.now();
      const day = now.toISOString().slice(0, 10);
      const stats = aggregateCases(fresh);
      const recommendations = await this.maybeRecommend(config, stats);

      const digestPath = join(keurmeesterDigestsDir(this.home), `${day}.md`);
      await mkdir(keurmeesterDigestsDir(this.home), { recursive: true });
      await writeFileAtomic(digestPath, renderDigest(day, stats, recommendations));

      const newestTs = fresh.reduce((max, r) => (r.ts > max ? r.ts : max), '');
      await this.writeState({ lastCaseTs: newestTs, lastRunAt: now.toISOString() });
      await this.history.log({
        kind: 'keurmeester.digest.generated',
        summary: `Keurmeester digest ${day}: ${stats.consults} consult(s), ${stats.unblockedRate} unblocked`,
        details: {
          day,
          path: digestPath,
          consults: stats.consults,
          applied: stats.applied,
          actions: stats.actions,
          outcomes: stats.outcomes,
        },
      });
      log.info(`digest ${day} written (${stats.consults} consults since last harvest)`);
      return true;
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * The frontier-authored systemic-recommendations section. Skipped
   * (stats-only digest) when no non-local consult target is configured
   * — the deterministic aggregation is the load-bearing part.
   */
  private async maybeRecommend(
    config: { keurmeester?: { providerName?: string; model?: string } },
    stats: CaseStats,
  ): Promise<string | null> {
    const provider = ProviderNameSchema.safeParse(config.keurmeester?.providerName);
    if (!provider.success || isLocalProvider(provider.data)) return null;
    const prompt = [
      'You are the Keurmeester reviewing your own intervention log to improve the guild systemically. Below is an aggregate of recent supervision cases (a frontier model rescuing small local models), plus per-case one-liners.',
      '',
      stats.promptBlock.slice(0, PROMPT_INPUT_CAP),
      '',
      'Write a short "Systemic recommendations" section (plain prose + at most 5 bullet points): which craftbook or task-shape changes would prevent the most repeated interventions, which failure classes look like model-capability ceilings rather than fixable task shapes, and any supervision-tuning suggestions (budgets, triggers). These are RECOMMENDATIONS for a human to approve — do not phrase them as actions you will take. Ground every claim in the data above.',
    ].join('\n');
    try {
      const text = (
        await this.oneShot(prompt, ONE_SHOT_TIMEOUT_MS, {
          providerName: provider.data,
          ...(config.keurmeester?.model ? { model: config.keurmeester.model } : {}),
          useKeurmeester: true,
          jobLabel: 'keurmeester · digest',
        })
      ).trim();
      return text || null;
    } catch (err) {
      log.warn(`digest recommendations failed (stats-only digest written): ${describe(err)}`);
      return null;
    }
  }

  private stateFile(): string {
    return keurmeesterDigestStatePath(this.home);
  }

  private async readState(): Promise<KeurmeesterDigestState> {
    try {
      return JSON.parse(await readFile(this.stateFile(), 'utf8')) as KeurmeesterDigestState;
    } catch {
      return {};
    }
  }

  private async writeState(state: KeurmeesterDigestState): Promise<void> {
    await mkdir(keurmeesterDigestsDir(this.home), { recursive: true });
    await writeFileAtomic(this.stateFile(), `${JSON.stringify(state, null, 2)}\n`);
  }
}

interface CaseStats {
  consults: number;
  applied: number;
  actions: Record<string, number>;
  failureClasses: Record<string, number>;
  outcomes: Record<string, number>;
  triggers: Record<string, number>;
  byModel: Record<string, number>;
  repeatOffenders: Array<{ taskRef: string; consults: number }>;
  unblockedRate: string;
  promptBlock: string;
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

/** Pure aggregation over one harvest window — exported for tests. */
export function aggregateCases(records: KeurmeesterCaseRecord[]): CaseStats {
  const stats: CaseStats = {
    consults: 0,
    applied: 0,
    actions: {},
    failureClasses: {},
    outcomes: {},
    triggers: {},
    byModel: {},
    repeatOffenders: [],
    unblockedRate: 'n/a',
    promptBlock: '',
  };
  const byTask = new Map<string, number>();
  const caseLines: string[] = [];
  const outcomeByCase = new Map<string, string>();
  for (const r of records) {
    if (r.record === 'case.closed' && r.outcome) outcomeByCase.set(r.caseId, r.outcome);
  }
  for (const r of records) {
    if (r.record !== 'case.opened') continue;
    stats.consults += 1;
    if (r.applied) stats.applied += 1;
    bump(stats.triggers, r.trigger);
    bump(stats.byModel, `${r.providerName}${r.model ? `/${r.model}` : ''}`);
    if (r.verdict) {
      bump(stats.actions, r.verdict.action.kind);
      bump(stats.failureClasses, r.verdict.failureClass);
    } else {
      bump(stats.actions, 'consult_failed');
    }
    if (r.taskRef) byTask.set(r.taskRef, (byTask.get(r.taskRef) ?? 0) + 1);
    const outcome = outcomeByCase.get(r.caseId);
    if (outcome) bump(stats.outcomes, outcome);
    caseLines.push(
      `- ${r.ts.slice(0, 16)} [${r.trigger}] ${r.providerName}${r.model ? `/${r.model}` : ''}${
        r.taskRef ? ` ${r.taskRef}` : ''
      }: ${r.verdict ? `${r.verdict.failureClass} → ${r.verdict.action.kind}` : 'consult failed'}${
        outcome ? ` (${outcome})` : ''
      }${r.verdict ? ` — ${r.verdict.diagnosis}` : ''}`,
    );
  }
  stats.repeatOffenders = [...byTask.entries()]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])
    .map(([taskRef, consults]) => ({ taskRef, consults }));
  const unblocked = stats.outcomes.unblocked ?? 0;
  const closed = Object.values(stats.outcomes).reduce((a, b) => a + b, 0);
  stats.unblockedRate = closed > 0 ? `${Math.round((unblocked / closed) * 100)}%` : 'n/a';

  const kv = (m: Record<string, number>) =>
    Object.entries(m)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}: ${n}`)
      .join(', ') || 'none';
  stats.promptBlock = [
    `Consults: ${stats.consults} (${stats.applied} applied)`,
    `Triggers: ${kv(stats.triggers)}`,
    `Failure classes: ${kv(stats.failureClasses)}`,
    `Actions: ${kv(stats.actions)}`,
    `Outcomes: ${kv(stats.outcomes)} (unblocked rate ${stats.unblockedRate})`,
    `Models: ${kv(stats.byModel)}`,
    stats.repeatOffenders.length > 0
      ? `Repeat offenders: ${stats.repeatOffenders.map((r) => `${r.taskRef} (${r.consults}×)`).join(', ')}`
      : 'Repeat offenders: none',
    '',
    '## Cases',
    ...caseLines,
  ].join('\n');
  return stats;
}

function renderDigest(day: string, stats: CaseStats, recommendations: string | null): string {
  const parts = [`# Keurmeester digest — ${day}`, '', stats.promptBlock, ''];
  if (recommendations) {
    parts.push('## Systemic recommendations', '', recommendations, '');
  } else {
    parts.push(
      '_No systemic-recommendations section: no frontier consult target configured (stats-only digest)._',
      '',
    );
  }
  return `${parts.join('\n')}`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
