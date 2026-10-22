/**
 * The verdict vocabulary for BW issues, in one place: what each verdict does
 * to the issue, what it is called on screen, and the definition an outside
 * app's model is given. The service, the UI, the outside-app prompts and the
 * handoff document all read it from here, so none can drift from the others.
 * See docs/issue-triage.md.
 */

import type {
  BoekwachterIssueDismissalReason,
  BoekwachterIssueStatus,
  IssueVerdictActor,
  IssueVerdictKind,
  IssueVerdictLogKind,
} from '../schemas/file-review.js';
import { HARNESS_CLIENT_LABELS, HarnessClientIdSchema } from '../schemas/harness-tools.js';

/** The issue state a verdict leaves behind. */
export function issueVerdictLifecycle(kind: IssueVerdictKind): {
  status: BoekwachterIssueStatus;
  dismissalReason?: BoekwachterIssueDismissalReason;
} {
  switch (kind) {
    case 'fixed':
      return { status: 'resolved' };
    case 'not_a_bug':
      return { status: 'dismissed', dismissalReason: 'not_an_issue' };
    case 'nit':
    case 'wont_fix':
      return { status: 'dismissed', dismissalReason: 'wont_fix' };
    case 'duplicate':
      return { status: 'dismissed', dismissalReason: 'duplicate' };
    case 'confirmed':
    case 'unsure':
      return { status: 'open' };
  }
}

export const ISSUE_VERDICT_LABELS: Record<IssueVerdictLogKind, string> = {
  fixed: 'Fixed',
  confirmed: 'Confirmed real',
  not_a_bug: 'Not a bug',
  nit: 'Not worth fixing',
  wont_fix: "Won't fix",
  duplicate: 'Duplicate',
  unsure: 'Unsure',
  recurred: 'Came back',
  echo: 'Repeat',
  superseded: 'Replaced',
  reopened: 'Reopened',
};

/**
 * One line per verdict for an outside app's model. The `nit` / `not_a_bug`
 * split is the one that matters: a true but trivial lead is a nit.
 */
export const ISSUE_VERDICT_DEFINITIONS: Record<IssueVerdictKind, string> = {
  fixed: 'the problem is real and you fixed it now',
  confirmed: 'the problem is real; you did not fix it',
  not_a_bug:
    'the lead is wrong: the code does not do what it says (reason "incorrect"), something else prevents it ("handled_elsewhere"), or it is deliberate ("intended")',
  nit: 'true, but too small to be worth fixing',
  wont_fix: 'real, but should be left as it is (say why)',
  duplicate: 'the same problem as another BW issue (give duplicateOf)',
  unsure: 'you could not tell from the code; say what would settle it',
};

/** How a verdict counts toward the reviewer's accuracy. */
export function issueVerdictClass(
  kind: IssueVerdictLogKind,
): 'actionable' | 'valid' | 'wrong' | 'undecided' {
  switch (kind) {
    case 'fixed':
    case 'confirmed':
      return 'actionable';
    case 'nit':
    case 'wont_fix':
      return 'valid';
    case 'not_a_bug':
      return 'wrong';
    default:
      return 'undecided';
  }
}

/** Who reached a verdict, in a few words: "You", "Claude Code", "A gezel", "An import". */
export function issueVerdictActorLabel(
  by: IssueVerdictActor,
  gezelName?: (gezelId: string) => string | undefined,
): string {
  switch (by.kind) {
    case 'person':
      return 'You';
    case 'app': {
      const parsed = HarnessClientIdSchema.safeParse(by.client);
      return parsed.success ? HARNESS_CLIENT_LABELS[parsed.data] : by.client;
    }
    case 'gezel':
      return gezelName?.(by.gezelId) ?? 'A gezel';
    case 'import':
      return by.declaredApp ? `Imported (${by.declaredApp})` : 'Imported';
    case 'system':
      return 'Gezel';
  }
}
