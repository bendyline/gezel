/**
 * Periodic Klerk-driven compaction of the daily memory corpus. Where the
 * health monitor keeps the derived vector cache in sync, this keeps the
 * SOURCE — the daily markdown files — from accumulating duplicates and
 * stale status notes forever: days older than the configured horizon are
 * merged/deduplicated by an LLM pass and rewritten in place (as honest
 * per-day files, so every existing reader keeps working), with the
 * originals archived under `memories/archive/<runId>/` first.
 *
 * Failure-safe by construction: nothing in the corpus is mutated until
 * the LLM output has been parsed and validated; the archive copy lands
 * before any rewrite; every new file is written atomically. A crash at
 * any point leaves either the original corpus or original + consolidated
 * duplicates (cleaned up by the next sweep) — never data loss.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type GezelConfig, createLogger, isProactiveAllowed } from '@bendyline/gezel';
import { writeFileAtomic } from '../fs/atomic.js';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import {
  DEFAULT_MEMORY_KIND,
  type MemoryKind,
  formatMemoryBlock,
  isMemoryKind,
  parseMemoryDay,
} from './daily-markdown.js';
import { embeddingsDisabledReason } from './embeddings.js';
import { runLessonsDistillation } from './lessons.js';
import type { MemoryManager } from './manager.js';

const log = createLogger('memory');

const STARTUP_DELAY_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Only days at least this old are eligible. The ≥2 floor is the
 * extraction-race invariant: `Store.appendMemory` only ever writes
 * TODAY's file, so with a horizon of at least two days compaction and
 * live extraction touch disjoint files by construction — even across a
 * midnight rollover mid-sweep (yesterday is still inside the horizon).
 */
const MIN_OLDER_THAN_DAYS = 2;
const DEFAULT_OLDER_THAN_DAYS = 14;
/** Skip scopes whose eligible window is too small to be worth a Klerk call. */
const DEFAULT_MIN_ENTRIES = 30;
/** Char budget for the entries handed to the LLM — oldest whole days first. */
const COMPACT_INPUT_BUDGET = 24_000;
/**
 * Abort if fewer than this fraction of input entries survive — an LLM
 * reply that "deletes everything" must never delete anything.
 */
const MIN_SURVIVOR_RATIO = 0.1;
/** Abort if fewer than this fraction of non-blank output lines parse. */
const MIN_PARSE_RATIO = 0.8;

const COMPACT_PROMPT = `You are a memory-compaction system. Below are dated memory entries from an AI agent's long-term store. Rewrite them into a smaller, deduplicated set.

Rules:
- Merge duplicates and near-duplicates into ONE entry; keep the earliest date of the merged group.
- Merge closely related facts into a single concise sentence when no information is lost.
- Discard trivia, greetings, dead ends, and one-off operational chatter.
- Discard stale status entries (work described as in-progress weeks ago). Keep decisions, preferences, and durable facts regardless of age.
- NEVER invent facts. Every output entry must be directly supported by the input.
- Preserve each entry's kind tag: fact, decision, pref, or status. If an input entry has no tag, use fact.
- Each entry is ONE clear, self-contained sentence.

Output format — one entry per line, nothing else, no headings, no commentary:
YYYY-MM-DD [kind] text

Use the (approximate) date the information came from. If nothing is worth keeping, respond with exactly: NONE.

Entries:
`;

const OUTPUT_LINE_RE = /^(\d{4}-\d{2}-\d{2})(?:\s*\[([a-z]+)\])?\s+(.+)$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export type CompactOneShot = (
  prompt: string,
  timeoutMs: number,
  opts: { useKlerk: true; jobLabel: string },
) => Promise<string>;

export interface MemoryCompactorOptions {
  memory: MemoryManager;
  store: Store;
  /** `ChatManager.oneShotCompletion` bound — injected so tests can stub it. */
  oneShot: CompactOneShot;
  history?: HistoryManager;
  /**
   * Growth engine — when present, each gezel's XP/level refresh rides
   * this sweep (after lessons distillation, so a same-sweep lessons
   * update is countable). Ambient growth therefore pauses with memory
   * maintenance / non-proactive engagement; the explicit refresh route
   * is the user-initiated escape hatch.
   */
  growth?: { refresh(gezelId: string, opts: { allowKlerk: boolean }): Promise<unknown> };
  /** Override the periodic interval (used by tests). */
  intervalMs?: number;
  /** Override the startup delay (used by tests). */
  startupDelayMs?: number;
}

interface CompactionState {
  lastRunAt?: string;
  inputHash?: string;
  /** Set by the lessons distiller (lessons.ts) — shares this state file. */
  lessonsInputHash?: string;
}

interface ScopeTarget {
  scope: 'gezel' | 'project';
  id: string;
}

interface ParsedEntry {
  day: string;
  kind: MemoryKind;
  text: string;
}

export class MemoryCompactor {
  private readonly memory: MemoryManager;
  private readonly store: Store;
  private readonly oneShot: CompactOneShot;
  private readonly history: HistoryManager | undefined;
  private readonly growth: MemoryCompactorOptions['growth'];
  private readonly intervalMs: number;
  private readonly startupDelayMs: number;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private sweepInFlight = false;

  constructor(opts: MemoryCompactorOptions) {
    this.memory = opts.memory;
    this.store = opts.store;
    this.oneShot = opts.oneShot;
    this.history = opts.history;
    this.growth = opts.growth;
    this.intervalMs = opts.intervalMs ?? SWEEP_INTERVAL_MS;
    this.startupDelayMs = opts.startupDelayMs ?? STARTUP_DELAY_MS;
  }

  start(): void {
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.sweep().catch((err) => {
        log.warn('[compact] startup sweep failed:', err);
      });
    }, this.startupDelayMs);
    this.startupTimer.unref?.();

    this.periodicTimer = setInterval(() => {
      void this.sweep().catch((err) => {
        log.warn('[compact] periodic sweep failed:', err);
      });
    }, this.intervalMs);
    this.periodicTimer.unref?.();
  }

  stop(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }

  /**
   * Walk every gezel + project memory dir and compact each one's aged
   * window. Public so tests (and a future admin endpoint) can trigger
   * on demand. Per-target failures are isolated.
   */
  async sweep(): Promise<{ compacted: number; checked: number }> {
    if (this.sweepInFlight) return { compacted: 0, checked: 0 };
    this.sweepInFlight = true;
    try {
      const config = await this.store.readConfig();
      if (config.memory?.maintenance?.enabled === false) return { compacted: 0, checked: 0 };
      if (!isProactiveAllowed(config)) return { compacted: 0, checked: 0 };

      const [gezels, projects] = await Promise.all([
        this.store.listGezels(),
        this.store.listProjects(),
      ]);
      const targets: ScopeTarget[] = [
        ...gezels.map((g) => ({ scope: 'gezel' as const, id: g.id })),
        ...projects.map((p) => ({ scope: 'project' as const, id: p.id })),
      ];
      let compacted = 0;
      for (const t of targets) {
        try {
          if (await this.compactScope(t, config)) compacted++;
        } catch (err) {
          log.warn(`[compact] ${t.scope}/${t.id} failed:`, err);
        }
        // Lessons distillation rides the same sweep for gezel scopes —
        // independent gates, isolated failures. Growth refresh runs
        // after lessons so a same-sweep lessons update is countable.
        if (t.scope === 'gezel') {
          try {
            await this.distillLessons(t.id, config);
          } catch (err) {
            log.warn(`[lessons] ${t.id} failed:`, err);
          }
          try {
            await this.growth?.refresh(t.id, { allowKlerk: config.growth?.enabled !== false });
          } catch (err) {
            log.warn(`[growth] ${t.id} failed:`, err);
          }
        }
      }
      if (compacted > 0) {
        log.info(`[compact] sweep compacted ${compacted}/${targets.length} scope(s)`);
      }
      return { compacted, checked: targets.length };
    } finally {
      this.sweepInFlight = false;
    }
  }

  /** Compact one scope's aged window. Returns true when a rewrite landed. */
  private async compactScope(target: ScopeTarget, config: GezelConfig): Promise<boolean> {
    const { scope, id } = target;
    const olderThanDays = Math.max(
      MIN_OLDER_THAN_DAYS,
      config.memory?.maintenance?.olderThanDays ?? DEFAULT_OLDER_THAN_DAYS,
    );
    const minEntries = config.memory?.maintenance?.minEntries ?? DEFAULT_MIN_ENTRIES;

    const cutoffDay = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const allDays = await this.store.listMemoryDays(scope, id);
    // ISO days compare lexicographically; skip non-day filenames defensively.
    const eligibleDays = allDays.filter((d) => DAY_RE.test(d) && d <= cutoffDay).sort();
    if (eligibleDays.length === 0) return false;

    const dayContents = new Map<string, string>();
    const entries: ParsedEntry[] = [];
    for (const day of eligibleDays) {
      const content = await this.store.readMemoryDay(scope, id, day);
      dayContents.set(day, content);
      for (const block of parseMemoryDay(content)) {
        entries.push({ day, kind: block.kind, text: block.text });
      }
    }
    if (entries.length < minEntries) return false;

    // Idempotency: the eligible window only changes when a new day ages
    // past the cutoff — don't re-feed an unchanged window to the Klerk
    // every 24h.
    const inputHash = createHash('sha256')
      .update(eligibleDays.map((d) => `${d}\n${dayContents.get(d)}`).join('\n'))
      .digest('hex');
    const state = await this.readState(scope, id);
    if (state.inputHash === inputHash) return false;

    // Oldest whole days first within the budget; the remainder stays
    // untouched and ages into the next sweep.
    const fedDays: string[] = [];
    let inputChars = 0;
    for (const day of eligibleDays) {
      const dayEntries = entries.filter((e) => e.day === day);
      const rendered = dayEntries
        .map((e) => `${e.day} [${e.kind}] ${e.text.replace(/\n+/g, ' ')}`)
        .join('\n');
      if (inputChars + rendered.length > COMPACT_INPUT_BUDGET && fedDays.length > 0) break;
      fedDays.push(day);
      inputChars += rendered.length + 1;
    }
    const fedEntries = entries.filter((e) => fedDays.includes(e.day));
    if (fedEntries.length < minEntries) return false;
    const input = fedEntries
      .map((e) => `${e.day} [${e.kind}] ${e.text.replace(/\n+/g, ' ')}`)
      .join('\n');

    const raw = (
      await this.oneShot(`${COMPACT_PROMPT}${input}`, 180_000, {
        useKlerk: true,
        jobLabel: `memory compact · ${scope}/${id}`,
      })
    ).trim();

    const survivors = this.parseOutput(raw, fedDays);
    if (!survivors) {
      log.warn(
        `[compact] ${scope}/${id} aborted — output failed validation (${raw.slice(0, 80)}…)`,
      );
      return false;
    }
    if (survivors.length < fedEntries.length * MIN_SURVIVOR_RATIO) {
      log.warn(
        `[compact] ${scope}/${id} aborted — only ${survivors.length}/${fedEntries.length} entries survived (< ${MIN_SURVIVOR_RATIO * 100}%)`,
      );
      return false;
    }

    // ── Write-new-then-swap ──
    // (a) Archive originals (pure copy — recoverable worst case).
    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    const archivedTo = await this.store.archiveMemoryDays(scope, id, fedDays, runId);

    // (b) Rewrite surviving days atomically.
    const byDay = new Map<string, ParsedEntry[]>();
    for (const s of survivors) {
      const bucket = byDay.get(s.day) ?? [];
      bucket.push(s);
      byDay.set(s.day, bucket);
    }
    for (const [day, dayEntries] of byDay) {
      const content = dayEntries
        // Synthetic 00:00 — original times only feed the index's `at`
        // column, which nothing ranks on.
        .map((e) => formatMemoryBlock('00:00', e.text, e.kind))
        .join('');
      await this.store.writeMemoryDay(scope, id, day, content);
    }

    // (c) Delete fed originals that have no surviving entries.
    for (const day of fedDays) {
      if (!byDay.has(day)) await this.store.deleteMemoryDay(scope, id, day);
    }

    // (d) State, reindex, history. A concurrent save() landing during
    // the rebuild can drop one index row — the health monitor's count
    // check self-heals that within 24h.
    await this.writeState(scope, id, { ...state, lastRunAt: new Date().toISOString(), inputHash });
    if (!embeddingsDisabledReason()) {
      await this.memory.reindex(scope, id);
    }
    await this.history?.log({
      kind: 'memory.compacted',
      ...(scope === 'project' ? { projectId: id } : { gezelId: id }),
      summary: `Compacted ${scope} memory: ${fedEntries.length} → ${survivors.length} entries across ${fedDays.length} → ${byDay.size} day file(s)`,
      details: {
        scope,
        id,
        daysIn: fedDays.length,
        daysOut: byDay.size,
        entriesIn: fedEntries.length,
        entriesOut: survivors.length,
        archivedTo,
      },
    });
    log.info(
      `[compact] ${scope}/${id}: ${fedEntries.length} → ${survivors.length} entries (${fedDays.length} → ${byDay.size} days), originals archived to ${archivedTo}`,
    );
    return true;
  }

  /**
   * Parse + validate the LLM output. Returns null when the reply is
   * unusable (empty/NONE against a non-trivial input, or too few lines
   * parse) — the caller leaves the corpus untouched.
   */
  private parseOutput(raw: string, fedDays: string[]): ParsedEntry[] | null {
    if (!raw || raw === 'NONE') return null;
    const lines = raw
      .split('\n')
      .map((l) => l.replace(/^[-*]\s+/, '').trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) return null;

    const minDay = fedDays[0]!;
    const maxDay = fedDays[fedDays.length - 1]!;
    const parsed: ParsedEntry[] = [];
    for (const line of lines) {
      const m = line.match(OUTPUT_LINE_RE);
      if (!m) continue;
      // Clamp out-of-range dates into the fed window so a hallucinated
      // date can't make an entry look newer than the corpus it came from.
      let day = m[1]!;
      if (day < minDay) day = minDay;
      if (day > maxDay) day = maxDay;
      const kind = m[2] && isMemoryKind(m[2]) ? m[2] : DEFAULT_MEMORY_KIND;
      parsed.push({ day, kind, text: m[3]!.trim() });
    }
    if (parsed.length < lines.length * MIN_PARSE_RATIO) return null;
    return parsed;
  }

  /**
   * Refresh one gezel's lessons.md unless its inputs (recent gezel-scope
   * notes + the current document) are unchanged since the last run —
   * an unchanged corpus shouldn't burn a Klerk call every 24h.
   */
  private async distillLessons(gezelId: string, config: GezelConfig): Promise<void> {
    if (config.memory?.lessons?.enabled === false) return;
    const lookbackDays = config.memory?.lessons?.lookbackDays ?? 28;
    const notes = await this.memory.getRecent('gezel', gezelId, lookbackDays);
    if (!notes.trim()) return;
    const current = await this.store.readMemoryLessons(gezelId);
    const lessonsInputHash = createHash('sha256').update(`${notes}\n---\n${current}`).digest('hex');
    const state = await this.readState('gezel', gezelId);
    if (state.lessonsInputHash === lessonsInputHash) return;

    const { updated } = await runLessonsDistillation({
      store: this.store,
      memory: this.memory,
      oneShot: this.oneShot,
      ...(this.history ? { history: this.history } : {}),
      config,
      gezelId,
    });
    if (updated) {
      await this.writeState('gezel', gezelId, { ...state, lessonsInputHash });
    }
  }

  private statePath(scope: 'gezel' | 'project', id: string): string {
    // Sibling of daily/ — derived from the summary path's parent dir so
    // we don't add another Store accessor for one file.
    return join(this.store.memorySummaryPath(scope, id), '..', 'compaction-state.json');
  }

  private async readState(scope: 'gezel' | 'project', id: string): Promise<CompactionState> {
    try {
      return JSON.parse(await readFile(this.statePath(scope, id), 'utf8')) as CompactionState;
    } catch {
      return {};
    }
  }

  private async writeState(
    scope: 'gezel' | 'project',
    id: string,
    state: CompactionState,
  ): Promise<void> {
    await writeFileAtomic(this.statePath(scope, id), `${JSON.stringify(state, null, 2)}\n`);
  }
}
