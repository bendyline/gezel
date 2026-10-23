import {
  type BoekwachterIssue,
  type IssueHandoffFile,
  type IssueHandoffItem,
  type IssueHandoffRequest,
  type IssueHandoffResponse,
  isActiveDiffpackStatus,
  issueVerdictClass,
} from '@bendyline/gezel';
import type { DiffpackManager } from '../diffpack/manager.js';
import type { Store } from '../fs/store.js';
import type { ContentIndex } from '../index-store/content-index.js';
import { expectedRealScore, isLowConfidence, issueVerdictStats } from './calibration.js';

export const DEFAULT_HANDOFF_LIMIT = 20;
/** How long an outside app may hold the issues it was handed before the night shift may take them. */
export const HANDOFF_LEASE_MS = 2 * 60 * 60 * 1000;
/** Until this many verdicts exist, a batch samples instead of taking the top. */
export const FIRST_BATCH_UNTIL_VERDICTS = 20;
const FIRST_BATCH_MAX_MAJOR = 8;
/** Share of a sampled batch picked at random, so no category goes unjudged. */
const EXPLORE_SHARE = 0.2;
/** A later batch takes a file's other issues along, up to this many, since the app reads the file once. */
const PER_FILE_CAP = 4;

const SEVERITY_RANK: Record<string, number> = { major: 0, minor: 1, info: 2 };

export interface IssueHandoffDeps {
  contentIndex: Pick<ContentIndex, 'listFileIssues'>;
  diffpacks: Pick<DiffpackManager, 'list'>;
  store: Pick<Store, 'boekwachterIssues'>;
  /** Test seam for the exploration picks. */
  random?: () => number;
  now?: () => Date;
}

/**
 * The next batch of BW issues for an outside app (or the handoff document):
 * open, unclaimed, not on a file a proposal already targets, grouped by file.
 * A project with few verdicts gets a sampled batch, majors plus a spread of
 * categories plus some at random, because nobody knows yet which of the
 * reviewer's leads tend to be real; later batches take the most promising
 * first. Handing issues to an app leases them to it. See docs/issue-triage.md.
 */
export async function buildIssueHandoffQueue(
  deps: IssueHandoffDeps,
  projectId: string,
  req: IssueHandoffRequest,
  lease?: { client: string },
): Promise<IssueHandoffResponse> {
  const now = deps.now?.() ?? new Date();
  const nowIso = now.toISOString();
  const limit = req.limit ?? DEFAULT_HANDOFF_LIMIT;
  const mode = req.mode ?? 'triage';
  const [listed, packs, verdicts] = await Promise.all([
    deps.contentIndex.listFileIssues(projectId, { status: 'open', maxResults: 1000 }),
    deps.diffpacks.list(projectId).catch(() => []),
    deps.store.boekwachterIssues.readIssueVerdicts(projectId),
  ]);
  const proposed = new Set<string>();
  for (const pack of packs) {
    if (isActiveDiffpackStatus(pack.status)) for (const file of pack.files) proposed.add(file.path);
  }
  const prefix = req.pathPrefix?.replace(/^\.?\/+/, '');

  const eligible = listed.issues.filter((issue) => {
    if (issue.status !== 'open' || issue.taskRef || proposed.has(issue.path)) return false;
    // A major repeat of a dismissed lead stays open for a second look; a
    // lead replaced by its own rewording is not asked about twice.
    if (issue.supersededBy) return false;
    if (issue.handoff && issue.handoff.until > nowIso && issue.handoff.client !== lease?.client) {
      return false;
    }
    if (
      req.severity ? issue.severity !== req.severity : issue.severity === 'info' && !req.includeInfo
    ) {
      return false;
    }
    if (prefix && !issue.path.startsWith(prefix)) return false;
    // Triage asks what nobody has settled; a confirmed issue waits for a fix.
    if (mode === 'triage' && issue.latestVerdict?.kind === 'confirmed') return false;
    return true;
  });

  const decided = verdicts.filter((v) => issueVerdictClass(v.kind) !== 'undecided').length;
  const firstBatch = mode === 'triage' && decided < FIRST_BATCH_UNTIL_VERDICTS;
  const stats = issueVerdictStats(verdicts);
  // Categories the verdicts say are almost never real wait behind the rest;
  // one still goes in each batch, so a better reviewer would show up.
  const setAside = eligible.filter((i) => isLowConfidence(stats, i));
  const standing = eligible.filter((i) => !setAside.includes(i));
  const score = (i: BoekwachterIssue) => expectedRealScore(stats, i);
  const ranked = [...standing].sort((a, b) => compareForHandoff(a, b, mode, score));
  const selected = firstBatch
    ? sampleFirstBatch(ranked, limit, deps.random ?? Math.random)
    : packByFile(ranked, setAside.length > 0 ? limit - 1 : limit);
  if (!firstBatch && setAside.length > 0 && selected.length < limit) {
    const probe = setAside[Math.floor((deps.random ?? Math.random)() * setAside.length)];
    if (probe) selected.push(probe);
  }

  if (lease && selected.length > 0) {
    await deps.store.boekwachterIssues.leaseIssues(
      projectId,
      selected.map((i) => i.ref),
      { client: lease.client, until: new Date(now.getTime() + HANDOFF_LEASE_MS).toISOString() },
    );
  }

  return {
    files: groupByFile(selected),
    count: selected.length,
    remaining: eligible.length - selected.length,
    ...(setAside.length > 0 ? { lowConfidence: setAside.length } : {}),
    firstBatch,
    indexed: listed.indexed,
  };
}

/**
 * Confirmed first when fixing; then unjudged before doubted, current before
 * stale, likeliest real, worst, oldest.
 */
function compareForHandoff(
  a: BoekwachterIssue,
  b: BoekwachterIssue,
  mode: 'triage' | 'fix',
  score: (issue: BoekwachterIssue) => number,
): number {
  const verdictRank = (i: BoekwachterIssue) =>
    i.latestVerdict?.kind === 'confirmed'
      ? mode === 'fix'
        ? 0
        : 1
      : i.latestVerdict?.kind === 'unsure'
        ? 2
        : 1;
  return (
    verdictRank(a) - verdictRank(b) ||
    Number(a.stale) - Number(b.stale) ||
    score(b) - score(a) ||
    (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
    a.createdAt.localeCompare(b.createdAt)
  );
}

/**
 * The first batch: every current major issue (up to a cap), then the rest
 * spread round-robin across categories, with a share left to chance so a
 * category the ordering never reaches still gets judged.
 */
function sampleFirstBatch(
  ranked: readonly BoekwachterIssue[],
  limit: number,
  random: () => number,
): BoekwachterIssue[] {
  const picked: BoekwachterIssue[] = [];
  const taken = new Set<string>();
  const take = (issue: BoekwachterIssue) => {
    if (picked.length >= limit || taken.has(issue.ref)) return;
    picked.push(issue);
    taken.add(issue.ref);
  };
  for (const issue of ranked
    .filter((i) => i.severity === 'major' && !i.stale)
    .slice(0, FIRST_BATCH_MAX_MAJOR)) {
    take(issue);
  }
  const explore = Math.min(Math.ceil(limit * EXPLORE_SHARE), Math.max(0, limit - picked.length));
  const byCategory = new Map<string, BoekwachterIssue[]>();
  for (const issue of ranked) {
    if (taken.has(issue.ref)) continue;
    const key = issue.category
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-');
    const bucket = byCategory.get(key);
    if (bucket) bucket.push(issue);
    else byCategory.set(key, [issue]);
  }
  const buckets = [...byCategory.values()];
  while (picked.length < limit - explore && buckets.some((b) => b.length > 0)) {
    for (const bucket of buckets) {
      const next = bucket.shift();
      if (next) take(next);
      if (picked.length >= limit - explore) break;
    }
  }
  const rest = ranked.filter((i) => !taken.has(i.ref));
  while (picked.length < limit && rest.length > 0) {
    const [chosen] = rest.splice(Math.floor(random() * rest.length), 1);
    if (chosen) take(chosen);
  }
  return picked;
}

/** Later batches: the most promising issues, each bringing its file's other issues along. */
function packByFile(ranked: readonly BoekwachterIssue[], limit: number): BoekwachterIssue[] {
  const byFile = new Map<string, BoekwachterIssue[]>();
  for (const issue of ranked) {
    const list = byFile.get(issue.path);
    if (list) list.push(issue);
    else byFile.set(issue.path, [issue]);
  }
  const picked: BoekwachterIssue[] = [];
  const done = new Set<string>();
  for (const issue of ranked) {
    if (picked.length >= limit) break;
    if (done.has(issue.path)) continue;
    done.add(issue.path);
    for (const sibling of (byFile.get(issue.path) ?? []).slice(0, PER_FILE_CAP)) {
      if (picked.length >= limit) break;
      picked.push(sibling);
    }
  }
  return picked;
}

function groupByFile(issues: readonly BoekwachterIssue[]): IssueHandoffFile[] {
  const files = new Map<string, IssueHandoffItem[]>();
  for (const issue of issues) {
    const item: IssueHandoffItem = {
      ref: issue.ref,
      severity: issue.severity,
      category: issue.category,
      message: issue.message,
      ...(issue.line !== undefined ? { line: issue.line } : {}),
      stale: issue.stale,
      ...(issue.latestVerdict?.kind === 'confirmed' || issue.latestVerdict?.kind === 'unsure'
        ? {
            verdict: issue.latestVerdict.kind,
            ...(issue.latestVerdict.note ? { verdictNote: issue.latestVerdict.note } : {}),
          }
        : {}),
    };
    const list = files.get(issue.path);
    if (list) list.push(item);
    else files.set(issue.path, [item]);
  }
  return [...files].map(([path, items]) => ({
    path,
    issues: items.sort((a, b) => (a.line ?? 0) - (b.line ?? 0)),
  }));
}
