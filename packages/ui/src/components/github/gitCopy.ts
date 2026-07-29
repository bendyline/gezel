/**
 * User-facing copy for the GitHub tab and git status bar, centralized so
 * the no-jargon vocabulary ("save" not commit, "sync" not push/pull,
 * "GitHub's version" not theirs) stays consistent across surfaces.
 */

import type {
  CodeReviewKind,
  GitChangeKind,
  GitSyncResponse,
  GitWorkingChange,
} from '@bendyline/gezel';

export const GIT_COPY = {
  changesEmptyTitle: 'All changes saved ✓',
  changesEmptyBody: 'Everything here matches your last save.',
  savePlaceholder: 'Describe what you changed (optional)',
  saveAlsoSync: 'Also send to GitHub now',
  saveButton: 'Save changes',
  saveAndSyncButton: 'Save & sync',
  saveToast: 'Saved.',
  syncButtonTitle: 'Get new changes from GitHub and send yours',
  syncUpToDate: "You're already up to date.",
  syncAuth: 'GitHub needs you to sign in again. Open Settings → Toolsets to reconnect.',
  syncOffline: "Couldn't reach GitHub — check your connection and try again.",
  syncGenericError: 'Sync didn’t go through. Try again in a moment.',
  needsSaveTitle: 'Save your changes first',
  needsSaveBody:
    'You have changes that aren’t saved yet. Save them so nothing gets lost, then sync.',
  needsSaveConfirm: 'Go to changes',
  needsSaveCancel: 'Not now',
  nudgeBanner: 'New changes from GitHub are available.',
  conflictSub:
    'Pick which version to keep for each file — or let AI combine them. Nothing is final until you press Finish.',
  conflictMineTitle: 'Your version',
  conflictMineButton: 'Keep my version',
  conflictTheirsTitle: "GitHub's version",
  conflictTheirsButton: "Keep GitHub's version",
  conflictAiButton: 'Combine them with AI',
  conflictAiBusy: 'Combining the two versions…',
  conflictAiPreviewTitle: "Here's the combined version",
  conflictAiUse: 'Use this',
  conflictAiEdit: 'Edit it first',
  conflictAiBack: 'Back',
  conflictFinish: 'Finish sync',
  conflictFinishToast: 'All sorted — your project is synced.',
  conflictCancel: 'Cancel sync',
  conflictCancelTitle: 'Stop syncing?',
  conflictCancelBody:
    'Your files will go back to exactly how they were before you pressed Sync. Your saved changes are safe.',
  conflictCancelConfirm: 'Yes, cancel sync',
  conflictCancelKeep: 'Keep going',
  conflictResume: 'You were in the middle of a sync. Let’s finish sorting out these files.',
  diffBinary: "This file isn't text, so there's no preview.",
  diffBig: 'This is a big change — showing the first part.',
  diffShowAll: 'Show everything',
  timelineEmpty: 'No saves yet. When you save changes, they’ll show up here.',
  reviewTabLabel: 'Code review',
  reviewCommitButton: 'Review my changes',
  reviewCommitHint: 'Checks your unsaved work against your last save.',
  reviewPrButton: 'Review this branch',
  reviewPrHint: 'Checks everything on this branch against the main branch.',
  reviewRailButton: '✨ Review…',
  reviewRunning: 'is looking over the changes…',
  reviewNeedsAttention: 'The review hit a snag and needs a look.',
  reviewStop: 'Stop review…',
  reviewStopTitle: 'Stop this review?',
  reviewStopBody:
    'The reviewer will stop and no report will be written. The changes themselves are untouched.',
  reviewStopConfirm: 'Stop review',
  reviewAlreadyRunning: 'A review of that kind is already running — one at a time.',
  reviewNothingCommit: 'There are no unsaved changes to review.',
  reviewNothingPr: 'This branch has nothing new compared to the main branch.',
  reviewNoDefaultBranch: "Couldn't work out the repo's main branch — sync once and try again.",
  reviewDetachedHead: 'Switch to a branch first, then review.',
  reviewStartedToast: 'Review started.',
  reviewCanceledToast: 'Review stopped.',
  reviewOpenInArtifacts: 'Open in artifacts',
  reviewReportMissing:
    "The review finished but no report was written. The reviewer's task notes may say why.",
  reviewReportLoading: 'Loading the report…',
  reviewHistoryEmpty: 'No reviews yet. Run one before you save or open a pull request.',
} as const;

const REVIEW_KIND_WORDS: Record<CodeReviewKind, string> = {
  commit: 'Unsaved changes',
  pr: 'Branch',
};

export function reviewKindWord(kind: CodeReviewKind): string {
  return REVIEW_KIND_WORDS[kind] ?? 'Changes';
}

const KIND_WORDS: Record<GitChangeKind, string> = {
  modified: 'Edited',
  added: 'New',
  deleted: 'Deleted',
  renamed: 'Moved',
  conflicted: 'Needs attention',
};

export function changeKindWord(kind: GitChangeKind): string {
  return KIND_WORDS[kind] ?? 'Edited';
}

export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** "Updated README.md and 2 more files" — the no-AI save fallback. */
export function autoSaveMessage(changes: GitWorkingChange[]): string {
  if (changes.length === 0) return 'Saved changes';
  const first = changes[0]!;
  const name = first.path.split('/').pop() ?? first.path;
  const verb =
    first.kind === 'added'
      ? 'Added'
      : first.kind === 'deleted'
        ? 'Deleted'
        : first.kind === 'renamed'
          ? 'Moved'
          : 'Updated';
  const rest = changes.length - 1;
  return rest > 0 ? `${verb} ${name} and ${plural(rest, 'more file')}` : `${verb} ${name}`;
}

/** "Got 3 new changes from GitHub. Sent 2 saved changes." */
export function syncedToast(result: GitSyncResponse): string {
  const parts: string[] = [];
  if (result.pulled > 0) parts.push(`Got ${plural(result.pulled, 'new change')} from GitHub.`);
  if (result.pushed > 0) parts.push(`Sent ${plural(result.pushed, 'saved change')} to GitHub.`);
  if (parts.length === 0) return GIT_COPY.syncUpToDate;
  return parts.join(' ');
}

/**
 * The status bar chip phrase — one plain-language line for the whole
 * git state, replacing the old `↑2 ↓1 ●` counters.
 */
export function statusChipPhrase(args: {
  mergeInProgress?: boolean;
  changesCount?: number;
  ahead?: number;
  behind?: number;
}): string {
  if (args.mergeInProgress) return 'Sync needs your help';
  const bits: string[] = [];
  if ((args.changesCount ?? 0) > 0) bits.push(plural(args.changesCount!, 'unsaved change'));
  if ((args.ahead ?? 0) > 0) bits.push(`${args.ahead} to send`);
  if ((args.behind ?? 0) > 0) bits.push(`${args.behind} to get`);
  if (bits.length === 0) return 'Up to date';
  return bits.join(' · ');
}

/** "yesterday" / "3d ago" / a calendar date — Timeline-friendly dates. */
export function friendlyDate(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const diffMs = Date.now() - then;
  const min = Math.round(diffMs / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day === 1) return 'yesterday';
  if (day < 7) return `${day}d ago`;
  return new Date(then).toLocaleDateString();
}
