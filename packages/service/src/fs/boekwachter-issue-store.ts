import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type BoekwachterIssueDismissalReason,
  type BoekwachterIssueStatus,
  type FileReviewIssue,
  ISSUE_VERDICT_LABELS,
  type IssueVerdictActor,
  type IssueVerdictEntry,
  IssueVerdictEntrySchema,
  type IssueVerdictInput,
  type IssueVerdictLogKind,
  type IssueVerdictSummary,
  IssueVerdictSummarySchema,
  KeyedLock,
  issueVerdictLifecycle,
  nowIso,
} from '@bendyline/gezel';
import { writeFileAtomic } from '@bendyline/gezel-inference/internal/fs/atomic';
import {
  projectBoekwachterIssuesFile,
  projectBoekwachterVerdictsFile,
} from '@bendyline/gezel/paths';
import { matchEarlierLead } from '../issue-triage/echo.js';

/** One verdict to apply, with the file's live hash read by the caller outside the lock. */
export interface IssueVerdictApplication {
  input: IssueVerdictInput;
  /** sha256 of the file as it is now; null when it could not be read. */
  fileHash: string | null;
}

export interface IssueVerdictOutcome {
  ref: string;
  outcome: 'applied' | 'refused';
  message: string;
  record?: ProjectBoekwachterIssueRecord;
}

const NOTE_EXCERPT_CHARS = 300;

export interface ProjectBoekwachterIssueRecord extends FileReviewIssue {
  id: string;
  ref: string;
  fingerprint: string;
  path: string;
  status: BoekwachterIssueStatus;
  taskRef?: string;
  dismissalReason?: BoekwachterIssueDismissalReason;
  createdAt: string;
  lastSeenAt: string;
  lastSeenContentHash: string;
  lastCheckedAt?: string;
  lastCheckedContentHash?: string;
  seenAt?: string;
  resolvedAt?: string;
  dismissedAt?: string;
  /** The newest verdict; every verdict is in `boekwachter-verdicts.jsonl`. */
  latestVerdict?: IssueVerdictSummary;
  firstReviewModel?: string;
  lastReviewModel?: string;
  echoOf?: string;
  supersededBy?: string;
  /** An outside app is checking this issue; the night shift leaves it alone until `until`. */
  handoffLease?: { client: string; until: string };
}

interface ProjectBoekwachterIssuesFile {
  version: 1;
  nextNumber: number;
  issues: Record<string, ProjectBoekwachterIssueRecord>;
}

export interface BoekwachterReviewObservation {
  path: string;
  contentHash: string;
  issues: FileReviewIssue[];
  /** The model that wrote the review, when recorded. */
  model?: string;
}

/** Stable across line movement; the content hash tracks the exact occurrence separately. */
export function boekwachterIssueFingerprint(path: string, issue: FileReviewIssue): string {
  const normalized = [
    'boekwachter-v1',
    path.replaceAll('\\', '/').trim(),
    issue.category.trim().toLocaleLowerCase(),
    issue.message.trim().toLocaleLowerCase().replace(/\s+/g, ' '),
  ].join('\0');
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Owns `boekwachter-issues.json`: the durable BW records the review pass
 * materializes, and their lifecycle. Reached through `Store`, which keeps the
 * public methods; moved out of store.ts whole, with the same names.
 */
export class BoekwachterIssueStore {
  private readonly locks = new KeyedLock();

  constructor(private readonly home: string) {}

  /**
   * Materialize current review output into durable BW records. Review rows are
   * disposable and content-hash keyed; these records intentionally are not.
   *
   * The path and fingerprint lookups are built once up front. Scanning
   * `Object.values(state.issues)` per observation *and* per issue was
   * quadratic, and both factors grow with the same thing — a repo with 2.4k
   * reviewed paths and 7.7k open findings spent ~10s of blocked event loop
   * here, on every workspace file the UI opened (`file-review` reconciles
   * before it reads).
   */
  async observeProjectBoekwachterReviews(
    id: string,
    observations: readonly BoekwachterReviewObservation[],
  ): Promise<void> {
    if (observations.length === 0) return;
    await this.withBoekwachterIssueLock(id, async () => {
      const state = await this.readProjectBoekwachterIssuesFile(id);
      let changed = false;
      const at = nowIso();
      const systemEntries: IssueVerdictEntry[] = [];

      const recordsByPath = new Map<string, ProjectBoekwachterIssueRecord[]>();
      const recordByFingerprint = new Map<string, ProjectBoekwachterIssueRecord>();
      const fingerprintKey = (path: string, fingerprint: string) => `${path}\0${fingerprint}`;
      for (const record of Object.values(state.issues)) {
        const forPath = recordsByPath.get(record.path);
        if (forPath) forPath.push(record);
        else recordsByPath.set(record.path, [record]);
        // First writer wins, matching the `.find()` this replaced.
        const key = fingerprintKey(record.path, record.fingerprint);
        if (!recordByFingerprint.has(key)) recordByFingerprint.set(key, record);
      }

      for (const observation of observations) {
        const path = observation.path.replaceAll('\\', '/');
        const pathRecords = recordsByPath.get(path) ?? [];
        // What each record was last checked against before this review, so a
        // file that moves back to content a fix had changed can be told apart
        // from a file that never changed.
        const previouslyChecked = new Map<ProjectBoekwachterIssueRecord, string | undefined>();
        for (const record of pathRecords) {
          previouslyChecked.set(record, record.lastCheckedContentHash);
          if (record.lastCheckedContentHash === observation.contentHash) continue;
          record.lastCheckedContentHash = observation.contentHash;
          record.lastCheckedAt = at;
          changed = true;
        }

        // New leads are created after the known ones are matched, so a
        // rewording can be linked to the earlier issue this review no longer
        // reports in the old words.
        const fresh: Array<{ issue: FileReviewIssue; fingerprint: string }> = [];
        for (const issue of observation.issues) {
          const fingerprint = boekwachterIssueFingerprint(path, issue);
          const record = recordByFingerprint.get(fingerprintKey(path, fingerprint));
          if (!record) {
            fresh.push({ issue, fingerprint });
            continue;
          }

          const seenOnNewContent = record.lastSeenContentHash !== observation.contentHash;
          if (record.severity !== issue.severity) {
            record.severity = issue.severity;
            changed = true;
          }
          if (record.category !== issue.category) {
            record.category = issue.category;
            changed = true;
          }
          if (record.message !== issue.message) {
            record.message = issue.message;
            changed = true;
          }
          if (record.line !== issue.line) {
            if (issue.line === undefined) delete record.line;
            else record.line = issue.line;
            changed = true;
          }
          if (
            observation.model &&
            seenOnNewContent &&
            record.lastReviewModel !== observation.model
          ) {
            record.lastReviewModel = observation.model;
            changed = true;
          }
          // The file went back to the very content this lead was reported on
          // after a review saw it changed: a fix that was reverted. The
          // fresh-content rule below cannot see it, since the hash is not new.
          const reverted =
            !seenOnNewContent &&
            record.status === 'resolved' &&
            previouslyChecked.get(record) !== undefined &&
            previouslyChecked.get(record) !== observation.contentHash;
          if (seenOnNewContent) {
            record.lastSeenContentHash = observation.contentHash;
            record.lastSeenAt = at;
            changed = true;
          }
          // A resolved lead reported again by a genuinely fresh review is a
          // recurrence. A user dismissal is an explicit opinion and stays
          // dismissed until they reopen it.
          if (record.status === 'resolved' && (seenOnNewContent || reverted)) {
            record.status = 'open';
            delete record.taskRef;
            delete record.resolvedAt;
            const entry = verdictEntry(record, { kind: 'recurred', by: { kind: 'system' }, at });
            record.latestVerdict = summarize(entry);
            systemEntries.push(entry);
            changed = true;
          }
          if (record.lastCheckedContentHash !== observation.contentHash) {
            record.lastCheckedContentHash = observation.contentHash;
            record.lastCheckedAt = at;
            changed = true;
          }
        }

        // Earlier leads this review did not repeat word for word, and that
        // are still standing: the ones a rewording could be.
        const unrepeated = pathRecords.filter(
          (r) =>
            r.lastSeenContentHash !== observation.contentHash &&
            r.status !== 'resolved' &&
            !r.supersededBy,
        );
        let autoDismissed = 0;
        for (const { issue, fingerprint } of fresh) {
          // The same lead twice in one review becomes one issue.
          if (recordByFingerprint.has(fingerprintKey(path, fingerprint))) continue;
          const created: ProjectBoekwachterIssueRecord = {
            id: randomUUID(),
            ref: `BW-${state.nextNumber++}`,
            fingerprint,
            path,
            severity: issue.severity,
            category: issue.category,
            message: issue.message,
            ...(issue.line !== undefined ? { line: issue.line } : {}),
            status: 'open',
            createdAt: at,
            lastSeenAt: at,
            lastSeenContentHash: observation.contentHash,
            lastCheckedAt: at,
            lastCheckedContentHash: observation.contentHash,
            ...(observation.model
              ? { firstReviewModel: observation.model, lastReviewModel: observation.model }
              : {}),
          };
          const earlier = matchEarlierLead(issue, unrepeated);
          if (earlier) {
            const linked = linkRepeat(created, earlier, at, autoDismissed < MAX_AUTO_DISMISS);
            if (linked.autoDismissed) autoDismissed++;
            systemEntries.push(...linked.entries);
          }
          state.issues[created.id] = created;
          // Keep the lookups live: a later observation of the same path must
          // see this record, exactly as the old full scan of `state.issues` did.
          pathRecords.push(created);
          if (!recordsByPath.has(path)) recordsByPath.set(path, pathRecords);
          recordByFingerprint.set(fingerprintKey(path, fingerprint), created);
          changed = true;
        }
      }

      if (changed) await this.writeProjectBoekwachterIssuesFile(id, state);
      await this.appendVerdictEntries(id, systemEntries);
    });
  }

  async listProjectBoekwachterIssues(id: string): Promise<ProjectBoekwachterIssueRecord[]> {
    const state = await this.readProjectBoekwachterIssuesFile(id);
    return Object.values(state.issues).sort(
      (a, b) => Number(a.ref.slice(3)) - Number(b.ref.slice(3)),
    );
  }

  async getProjectBoekwachterIssue(
    id: string,
    ref: string,
  ): Promise<ProjectBoekwachterIssueRecord | null> {
    return (await this.listProjectBoekwachterIssues(id)).find((issue) => issue.ref === ref) ?? null;
  }

  async updateProjectBoekwachterIssue(
    id: string,
    ref: string,
    patch: {
      status?: BoekwachterIssueStatus;
      seen?: boolean;
      taskRef?: string;
      dismissalReason?: BoekwachterIssueDismissalReason;
    },
  ): Promise<ProjectBoekwachterIssueRecord | null> {
    return this.withBoekwachterIssueLock(id, async () => {
      const state = await this.readProjectBoekwachterIssuesFile(id);
      const record = Object.values(state.issues).find((issue) => issue.ref === ref);
      if (!record) return null;
      const at = nowIso();

      if (patch.seen !== undefined) {
        if (patch.seen) record.seenAt = at;
        else delete record.seenAt;
      }
      if (patch.status !== undefined)
        setIssueStatus(record, patch.status, patch.dismissalReason, at);
      if (patch.taskRef) record.taskRef = patch.taskRef;
      await this.writeProjectBoekwachterIssuesFile(id, state);
      return record;
    });
  }

  /**
   * Apply verdicts under one lock, one write and one log append. Refusals are
   * per item and never stop the rest: an app reporting twenty verdicts should
   * hear which three did not land and why.
   */
  async applyIssueVerdicts(
    id: string,
    items: readonly IssueVerdictApplication[],
    by: IssueVerdictActor,
  ): Promise<IssueVerdictOutcome[]> {
    return this.withBoekwachterIssueLock(id, async () => {
      const state = await this.readProjectBoekwachterIssuesFile(id);
      const byRef = new Map(Object.values(state.issues).map((r) => [r.ref, r]));
      const at = nowIso();
      const entries: IssueVerdictEntry[] = [];
      const outcomes: IssueVerdictOutcome[] = [];

      for (const { input, fileHash } of items) {
        const record = byRef.get(input.ref);
        if (!record) {
          outcomes.push({
            ref: input.ref,
            outcome: 'refused',
            message: `${input.ref} doesn't exist in this project.`,
          });
          continue;
        }
        if (record.status === 'in_progress' && record.taskRef && by.kind !== 'person') {
          outcomes.push({
            ref: input.ref,
            outcome: 'refused',
            message: `${input.ref} is being worked on in task ${record.taskRef}; leave it to that task.`,
          });
          continue;
        }
        if (input.kind === 'duplicate' && !(input.duplicateOf && byRef.has(input.duplicateOf))) {
          outcomes.push({
            ref: input.ref,
            outcome: 'refused',
            message: `${input.duplicateOf ?? 'duplicateOf'} doesn't exist in this project.`,
          });
          continue;
        }
        // "Fixed" while the file still has the exact content the lead was
        // reported on: the fix may be elsewhere, but gezel cannot see it.
        const unverified =
          input.kind === 'fixed' && fileHash !== null && fileHash === record.lastSeenContentHash;
        const { status, dismissalReason } = issueVerdictLifecycle(input.kind);
        // Confirming or doubting a lead that a task is already fixing leaves the task alone.
        if (!(status === 'open' && record.status === 'in_progress')) {
          setIssueStatus(record, status, dismissalReason, at);
        }
        delete record.handoffLease;
        const entry = verdictEntry(record, {
          kind: input.kind,
          ...(input.kind === 'not_a_bug' ? { reason: input.reason ?? 'incorrect' } : {}),
          ...(input.note?.trim() ? { note: input.note.trim() } : {}),
          ...(input.duplicateOf ? { duplicateOf: input.duplicateOf } : {}),
          ...(unverified ? { unverified: true } : {}),
          by,
          at,
          fileHash,
          preFixHash: record.lastSeenContentHash,
        });
        record.latestVerdict = summarize(entry);
        entries.push(entry);
        outcomes.push({
          ref: input.ref,
          outcome: 'applied',
          message: unverified
            ? `${input.ref} marked fixed, but the file hasn't changed since the review, so Gezel can't confirm it.`
            : `${input.ref} is now ${record.status}.`,
          record,
        });
      }

      if (entries.length > 0) {
        await this.writeProjectBoekwachterIssuesFile(id, state);
        await this.appendVerdictEntries(id, entries);
      }
      return outcomes;
    });
  }

  /**
   * The person reopening a closed issue. Logged as `reopened`, because an
   * override of an earlier verdict is the signal that verdict was wrong.
   */
  async reopenIssue(
    id: string,
    ref: string,
    by: IssueVerdictActor,
  ): Promise<ProjectBoekwachterIssueRecord | null> {
    return this.withBoekwachterIssueLock(id, async () => {
      const state = await this.readProjectBoekwachterIssuesFile(id);
      const record = Object.values(state.issues).find((issue) => issue.ref === ref);
      if (!record) return null;
      const at = nowIso();
      const wasClosed = record.status === 'resolved' || record.status === 'dismissed';
      setIssueStatus(record, 'open', undefined, at);
      if (wasClosed) {
        const entry = verdictEntry(record, { kind: 'reopened', by, at });
        record.latestVerdict = summarize(entry);
        await this.appendVerdictEntries(id, [entry]);
      }
      await this.writeProjectBoekwachterIssuesFile(id, state);
      return record;
    });
  }

  /**
   * Mark issues as being checked by an outside app until `until`, so the
   * night shift doesn't start fixing what the app is still judging. A verdict
   * clears the lease; an abandoned one simply runs out.
   */
  async leaseIssues(
    id: string,
    refs: readonly string[],
    lease: { client: string; until: string },
  ): Promise<void> {
    if (refs.length === 0) return;
    await this.withBoekwachterIssueLock(id, async () => {
      const state = await this.readProjectBoekwachterIssuesFile(id);
      const wanted = new Set(refs);
      let changed = false;
      for (const record of Object.values(state.issues)) {
        if (!wanted.has(record.ref) || record.status !== 'open' || record.taskRef) continue;
        record.handoffLease = { ...lease };
        changed = true;
      }
      if (changed) await this.writeProjectBoekwachterIssuesFile(id, state);
    });
  }

  /** Every verdict on the project's issues, oldest first. Unreadable lines are skipped. */
  async readIssueVerdicts(id: string): Promise<IssueVerdictEntry[]> {
    let text: string;
    try {
      text = await readFile(projectBoekwachterVerdictsFile(this.home, id), 'utf8');
    } catch {
      return [];
    }
    const entries: IssueVerdictEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = IssueVerdictEntrySchema.safeParse(JSON.parse(line));
        if (parsed.success) entries.push(parsed.data);
      } catch {
        // A torn final line from a crash mid-append; the rest still count.
      }
    }
    return entries;
  }

  private async appendVerdictEntries(
    id: string,
    entries: readonly IssueVerdictEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;
    const file = projectBoekwachterVerdictsFile(this.home, id);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, entries.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8');
  }

  async settleProjectBoekwachterIssuesForTask(
    id: string,
    taskRef: string,
    outcome: 'complete' | 'canceled',
  ): Promise<number> {
    return this.withBoekwachterIssueLock(id, async () => {
      const state = await this.readProjectBoekwachterIssuesFile(id);
      let changed = 0;
      const at = nowIso();
      for (const record of Object.values(state.issues)) {
        if (record.taskRef !== taskRef || record.status !== 'in_progress') continue;
        if (outcome === 'complete') {
          record.status = 'resolved';
          record.resolvedAt = at;
        } else {
          record.status = 'open';
          delete record.taskRef;
        }
        changed++;
      }
      if (changed > 0) await this.writeProjectBoekwachterIssuesFile(id, state);
      return changed;
    });
  }

  /**
   * Proposal lifecycle for Boekwachter issues. A drafted fix is not a fix, so
   * issues claimed by a drafting task stay in progress until the person acts
   * on the proposal: applying a file resolves the issues on that file, and an
   * issue no live proposal touches goes back to open. `taskRefs` is the
   * drafting family — the task that claimed the issues and its shards.
   */
  async settleProjectBoekwachterIssuesForProposal(
    id: string,
    taskRefs: readonly string[],
    change: { resolvePaths?: readonly string[]; reopenUnless?: ReadonlySet<string> },
  ): Promise<{ resolved: number; reopened: number }> {
    return this.withBoekwachterIssueLock(id, async () => {
      const state = await this.readProjectBoekwachterIssuesFile(id);
      const family = new Set(taskRefs);
      const resolve = new Set(change.resolvePaths ?? []);
      const at = nowIso();
      let resolved = 0;
      let reopened = 0;
      for (const record of Object.values(state.issues)) {
        if (record.status !== 'in_progress' || !record.taskRef || !family.has(record.taskRef)) {
          continue;
        }
        if (resolve.has(record.path)) {
          record.status = 'resolved';
          record.resolvedAt = at;
          resolved++;
        } else if (change.reopenUnless && !change.reopenUnless.has(record.path)) {
          record.status = 'open';
          delete record.taskRef;
          reopened++;
        }
      }
      if (resolved + reopened > 0) await this.writeProjectBoekwachterIssuesFile(id, state);
      return { resolved, reopened };
    });
  }

  private async readProjectBoekwachterIssuesFile(
    id: string,
  ): Promise<ProjectBoekwachterIssuesFile> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(projectBoekwachterIssuesFile(this.home, id), 'utf8'));
    } catch {
      return { version: 1, nextNumber: 1, issues: {} };
    }
    const root = parsed as { nextNumber?: unknown; issues?: unknown } | null;
    const raw = root?.issues;
    const issues: Record<string, ProjectBoekwachterIssueRecord> = {};
    let maxNumber = 0;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [id, value] of Object.entries(raw)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const row = value as Record<string, unknown>;
        if (
          typeof row.ref !== 'string' ||
          !/^BW-[1-9]\d*$/.test(row.ref) ||
          typeof row.fingerprint !== 'string' ||
          typeof row.path !== 'string' ||
          typeof row.category !== 'string' ||
          typeof row.message !== 'string' ||
          (row.severity !== 'info' && row.severity !== 'minor' && row.severity !== 'major') ||
          (row.status !== 'open' &&
            row.status !== 'in_progress' &&
            row.status !== 'resolved' &&
            row.status !== 'dismissed') ||
          typeof row.createdAt !== 'string' ||
          typeof row.lastSeenAt !== 'string' ||
          typeof row.lastSeenContentHash !== 'string'
        ) {
          continue;
        }
        const stableId = typeof row.id === 'string' && row.id ? row.id : id;
        issues[stableId] = {
          id: stableId,
          ref: row.ref,
          fingerprint: row.fingerprint,
          path: row.path,
          severity: row.severity,
          category: row.category,
          message: row.message,
          ...(typeof row.line === 'number' && row.line >= 1 ? { line: Math.round(row.line) } : {}),
          status: row.status,
          ...(typeof row.taskRef === 'string' ? { taskRef: row.taskRef } : {}),
          ...(row.dismissalReason === 'not_an_issue' ||
          row.dismissalReason === 'duplicate' ||
          row.dismissalReason === 'wont_fix'
            ? { dismissalReason: row.dismissalReason }
            : {}),
          createdAt: row.createdAt,
          lastSeenAt: row.lastSeenAt,
          lastSeenContentHash: row.lastSeenContentHash,
          ...(typeof row.lastCheckedAt === 'string' ? { lastCheckedAt: row.lastCheckedAt } : {}),
          ...(typeof row.lastCheckedContentHash === 'string'
            ? { lastCheckedContentHash: row.lastCheckedContentHash }
            : {}),
          ...(typeof row.seenAt === 'string' ? { seenAt: row.seenAt } : {}),
          ...(typeof row.resolvedAt === 'string' ? { resolvedAt: row.resolvedAt } : {}),
          ...(typeof row.dismissedAt === 'string' ? { dismissedAt: row.dismissedAt } : {}),
          ...readTriageFields(row),
        };
        maxNumber = Math.max(maxNumber, Number(row.ref.slice(3)) || 0);
      }
    }
    const requestedNext =
      typeof root?.nextNumber === 'number' && Number.isInteger(root.nextNumber)
        ? root.nextNumber
        : 1;
    return { version: 1, nextNumber: Math.max(maxNumber + 1, requestedNext, 1), issues };
  }

  private async writeProjectBoekwachterIssuesFile(
    id: string,
    state: ProjectBoekwachterIssuesFile,
  ): Promise<void> {
    await writeFileAtomic(
      projectBoekwachterIssuesFile(this.home, id),
      `${JSON.stringify(state, null, 2)}\n`,
    );
  }

  private async withBoekwachterIssueLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    return this.locks.run(id, fn);
  }
}

/** At most this many reworded repeats are closed by themselves per file per review. */
const MAX_AUTO_DISMISS = 5;

/**
 * What a new lead that rewords an earlier one inherits. A repeat of a lead
 * someone dismissed is closed the same way, unless it is major, which stays
 * open for a second look; a rewording of a lead still open replaces it, and
 * carries over a "confirmed" or "unsure" someone gave the old wording.
 */
function linkRepeat(
  created: ProjectBoekwachterIssueRecord,
  earlier: ProjectBoekwachterIssueRecord,
  at: string,
  mayDismiss: boolean,
): { autoDismissed: boolean; entries: IssueVerdictEntry[] } {
  const system = { kind: 'system' as const };
  if (earlier.status === 'dismissed') {
    created.echoOf = earlier.ref;
    const judged = earlier.latestVerdict?.kind ?? 'not_a_bug';
    const dismiss = created.severity !== 'major' && mayDismiss;
    if (dismiss) setIssueStatus(created, 'dismissed', 'duplicate', at);
    const entry = verdictEntry(created, {
      kind: 'echo',
      by: system,
      at,
      relatedRef: earlier.ref,
      ...(dismiss ? { duplicateOf: earlier.ref } : {}),
      note: `Repeats ${earlier.ref}, which was judged ${ISSUE_VERDICT_LABELS[judged].toLowerCase()}.`,
    });
    created.latestVerdict = summarize(entry);
    return { autoDismissed: dismiss, entries: [entry] };
  }
  if (earlier.status !== 'open') return { autoDismissed: false, entries: [] };
  earlier.supersededBy = created.ref;
  if (earlier.latestVerdict?.kind === 'confirmed' || earlier.latestVerdict?.kind === 'unsure') {
    created.latestVerdict = { ...earlier.latestVerdict };
  }
  const entry = verdictEntry(earlier, {
    kind: 'superseded',
    by: system,
    at,
    relatedRef: created.ref,
  });
  return { autoDismissed: false, entries: [entry] };
}

/** Set a lifecycle status and clear the fields that contradict it. */
function setIssueStatus(
  record: ProjectBoekwachterIssueRecord,
  status: BoekwachterIssueStatus,
  dismissalReason: BoekwachterIssueDismissalReason | undefined,
  at: string,
): void {
  record.status = status;
  if (status === 'resolved') {
    record.resolvedAt = at;
    delete record.dismissedAt;
    delete record.dismissalReason;
  } else if (status === 'dismissed') {
    record.dismissedAt = at;
    record.dismissalReason = dismissalReason ?? 'not_an_issue';
    delete record.resolvedAt;
    delete record.taskRef;
  } else {
    delete record.resolvedAt;
    delete record.dismissedAt;
    delete record.dismissalReason;
    if (status === 'open') delete record.taskRef;
  }
}

/** A verdict log line, snapshotting the lead as it reads when judged. */
function verdictEntry(
  record: ProjectBoekwachterIssueRecord,
  verdict: Omit<
    IssueVerdictEntry,
    'id' | 'issueId' | 'fingerprint' | 'ref' | 'path' | 'severity' | 'category' | 'message'
  > & {
    kind: IssueVerdictLogKind;
  },
): IssueVerdictEntry {
  return {
    id: randomUUID(),
    issueId: record.id,
    fingerprint: record.fingerprint,
    ref: record.ref,
    path: record.path,
    severity: record.severity,
    category: record.category,
    message: record.message,
    ...(record.lastReviewModel ? { reviewModel: record.lastReviewModel } : {}),
    ...verdict,
  };
}

function summarize(entry: IssueVerdictEntry): IssueVerdictSummary {
  return {
    kind: entry.kind,
    by: entry.by,
    at: entry.at,
    ...(entry.reason ? { reason: entry.reason } : {}),
    ...(entry.note ? { note: entry.note.slice(0, NOTE_EXCERPT_CHARS) } : {}),
    ...(entry.duplicateOf ? { duplicateOf: entry.duplicateOf } : {}),
    ...(entry.unverified ? { unverified: true } : {}),
  };
}

/** The triage fields on a stored record, each dropped alone if malformed. */
function readTriageFields(
  row: Record<string, unknown>,
): Partial<
  Pick<
    ProjectBoekwachterIssueRecord,
    | 'latestVerdict'
    | 'firstReviewModel'
    | 'lastReviewModel'
    | 'echoOf'
    | 'supersededBy'
    | 'handoffLease'
  >
> {
  const verdict = IssueVerdictSummarySchema.safeParse(row.latestVerdict);
  const lease = row.handoffLease as { client?: unknown; until?: unknown } | undefined;
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  return {
    ...(verdict.success ? { latestVerdict: verdict.data } : {}),
    ...(text(row.firstReviewModel) ? { firstReviewModel: text(row.firstReviewModel) } : {}),
    ...(text(row.lastReviewModel) ? { lastReviewModel: text(row.lastReviewModel) } : {}),
    ...(text(row.echoOf) ? { echoOf: text(row.echoOf) } : {}),
    ...(text(row.supersededBy) ? { supersededBy: text(row.supersededBy) } : {}),
    ...(text(lease?.client) && text(lease?.until)
      ? { handoffLease: { client: lease?.client as string, until: lease?.until as string } }
      : {}),
  };
}
