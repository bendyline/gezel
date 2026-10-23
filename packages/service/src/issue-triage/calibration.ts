import {
  type BoekwachterIssue,
  type IssueVerdictEntry,
  type IssueVerdictStatsResponse,
  issueVerdictClass,
} from '@bendyline/gezel';
import { normalizeIssueCategory } from './echo.js';

/**
 * How often the reviewer's leads turn out worth fixing, from the verdict log.
 * Used to put the likeliest-real issues first and, only with plenty of
 * evidence, to set aside a category that is almost never worth fixing. It
 * never deletes anything: set-aside issues stay listed as low-confidence, and
 * every batch still samples one so a change in the reviewer shows up. See
 * docs/issue-triage.md.
 *
 * The signal is "worth fixing", not "true". In the 2026-10-22 evaluation the
 * true rate sat at 50-72% in every category and never separated them, and it
 * is the soft one: Opus called a quarter of the leads a person judged true
 * "not a bug". The worth-fixing rate split bugs (56%) from smells (5%) and
 * held across random halves of the data (correlation 0.95).
 */

export interface VerdictTally {
  decided: number;
  /** fixed or confirmed */
  actionable: number;
  /** actionable, nit or wont_fix: the lead was true */
  valid: number;
  /** not_a_bug: the lead was wrong */
  wrong: number;
}

export interface IssueVerdictStats {
  overall: VerdictTally;
  /** Keyed `${reviewModel ?? 'unknown'}\0${category}`. */
  byModelCategory: Map<string, VerdictTally>;
  byCategory: Map<string, VerdictTally>;
  /** Per outside app: its decided verdicts, and how many the person later reopened. */
  apps: Map<string, { decided: number; dismissed: number; reopenedByPerson: number }>;
}

/** Demotion needs this many verdicts in a category... */
export const DEMOTE_MIN_VERDICTS = 40;
/** ...and the upper end of its worth-fixing rate's 95% interval below this. */
export const DEMOTE_MAX_ACTIONABLE_UPPER = 0.15;
/** A category's prior actionable rate, before verdicts say otherwise. */
const DEFAULT_PRIOR = 0.3;
const PRIOR_WEIGHT = 5;

const empty = (): VerdictTally => ({ decided: 0, actionable: 0, valid: 0, wrong: 0 });

/**
 * One verdict per issue counts: the latest decisive one. A person reopening
 * a dismissed issue undoes that dismissal, and counts against the app that
 * gave it, which is how an app whose verdicts the person keeps overriding is
 * caught.
 */
export function issueVerdictStats(entries: readonly IssueVerdictEntry[]): IssueVerdictStats {
  const latest = new Map<string, IssueVerdictEntry>();
  const apps: IssueVerdictStats['apps'] = new Map();
  const app = (client: string) => {
    let a = apps.get(client);
    if (!a) {
      a = { decided: 0, dismissed: 0, reopenedByPerson: 0 };
      apps.set(client, a);
    }
    return a;
  };
  for (const entry of entries) {
    if (entry.kind === 'reopened') {
      const before = latest.get(entry.issueId);
      if (
        before?.by.kind === 'app' &&
        entry.by.kind === 'person' &&
        issueVerdictClass(before.kind) !== 'actionable'
      ) {
        app(before.by.client).reopenedByPerson++;
      }
      latest.delete(entry.issueId);
      continue;
    }
    if (issueVerdictClass(entry.kind) === 'undecided') continue;
    latest.set(entry.issueId, entry);
    if (entry.by.kind === 'app') {
      const a = app(entry.by.client);
      a.decided++;
      if (entry.kind !== 'fixed' && entry.kind !== 'confirmed') a.dismissed++;
    }
  }

  const stats: IssueVerdictStats = {
    overall: empty(),
    byModelCategory: new Map(),
    byCategory: new Map(),
    apps,
  };
  const add = (map: Map<string, VerdictTally>, key: string, entry: IssueVerdictEntry) => {
    let t = map.get(key);
    if (!t) {
      t = empty();
      map.set(key, t);
    }
    count(t, entry);
  };
  for (const entry of latest.values()) {
    count(stats.overall, entry);
    const category = normalizeIssueCategory(entry.category);
    add(stats.byCategory, category, entry);
    add(stats.byModelCategory, modelCategoryKey(entry.reviewModel, category), entry);
  }
  return stats;
}

function count(t: VerdictTally, entry: IssueVerdictEntry): void {
  const cls = issueVerdictClass(entry.kind);
  t.decided++;
  if (cls === 'actionable') t.actionable++;
  if (cls === 'actionable' || cls === 'valid') t.valid++;
  if (cls === 'wrong') t.wrong++;
}

function modelCategoryKey(model: string | undefined, category: string): string {
  return `${model ?? 'unknown'}\0${category}`;
}

/** The 95% Wilson interval for k successes in n. */
export function wilsonInterval(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

function tallyFor(stats: IssueVerdictStats, issue: BoekwachterIssue): VerdictTally | undefined {
  const category = normalizeIssueCategory(issue.category);
  return stats.byModelCategory.get(modelCategoryKey(issue.reviewModel, category));
}

/**
 * How likely an issue is to be real, for ordering: its reviewer-and-category
 * actionable rate, pulled toward a prior until there are verdicts enough to
 * stand on their own.
 */
export function expectedRealScore(
  stats: IssueVerdictStats,
  issue: BoekwachterIssue,
  prior = DEFAULT_PRIOR,
): number {
  const t = tallyFor(stats, issue);
  return ((t?.actionable ?? 0) + prior * PRIOR_WEIGHT) / ((t?.decided ?? 0) + PRIOR_WEIGHT);
}

/** Almost never worth fixing, on enough verdicts that chance cannot explain it. */
function rarelyWorthFixing(t: VerdictTally | undefined): boolean {
  if (!t || t.decided < DEMOTE_MIN_VERDICTS) return false;
  return wilsonInterval(t.actionable, t.decided)[1] < DEMOTE_MAX_ACTIONABLE_UPPER;
}

/** Set aside: the reviewer's leads in this category are almost never worth fixing. Major issues never are. */
export function isLowConfidence(stats: IssueVerdictStats, issue: BoekwachterIssue): boolean {
  if (issue.severity === 'major') return false;
  return rarelyWorthFixing(tallyFor(stats, issue));
}

/** Mark each set-aside issue, for counts and badges that should leave them out. */
export function annotateLowConfidence(
  issues: readonly BoekwachterIssue[],
  stats: IssueVerdictStats,
): BoekwachterIssue[] {
  return issues.map((issue) =>
    isLowConfidence(stats, issue) ? { ...issue, lowConfidence: true } : issue,
  );
}

/** The stats for the wire. */
export function issueVerdictStatsResponse(stats: IssueVerdictStats): IssueVerdictStatsResponse {
  return {
    overall: stats.overall,
    categories: [...stats.byCategory]
      .map(([category, t]) => ({ category, ...t, lowConfidence: rarelyWorthFixing(t) }))
      .sort((a, b) => b.decided - a.decided),
    models: [...stats.byModelCategory].map(([key, t]) => {
      const [model = 'unknown', category = ''] = key.split('\0');
      return { model, category, ...t };
    }),
    apps: [...stats.apps].map(([client, a]) => ({ client, ...a })),
  };
}
