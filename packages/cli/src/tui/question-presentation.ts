import type { NpmInstallApprovalPackage, Question } from '@bendyline/gezel';

type QuestionIntentKind = NonNullable<Question['intent']>['kind'];

const TUI_APPROVAL_INTENTS = new Set<QuestionIntentKind>([
  'npm-install-approval',
  'command-approval',
  'tool-permission',
  'toolset-install-approval',
  'image-generation-approval',
  'video-generation-approval',
  'schedule-approval',
]);

/**
 * The terminal owns plain questions plus approvals it can settle through the
 * regular question-answer endpoint. Informational desktop cards (night-shift
 * review and task-paused) stay out of this blocking composer queue until the
 * TUI can also provide their navigation affordances.
 */
export function canAnswerQuestionInTui(question: Question): boolean {
  return !question.intent || TUI_APPROVAL_INTENTS.has(question.intent.kind);
}

/** Choices synthesized here also make older/malformed persisted approvals usable. */
export function choicesForQuestion(question: Question): string[] {
  if (question.choices && question.choices.length > 0) return question.choices;
  switch (question.intent?.kind) {
    case 'command-approval':
      return ['Approve', 'Decline'];
    case 'tool-permission':
      return ['Allow', 'Deny'];
    case 'toolset-install-approval':
      return ['Install', 'Not now'];
    case 'image-generation-approval':
    case 'video-generation-approval':
      return ['Allow once', 'Always allow', 'Decline'];
    case 'schedule-approval':
      return ['Enable schedule', 'Keep paused'];
    default:
      return [];
  }
}

export function allowsWriteIn(question: Question): boolean {
  return question.intent ? false : (question.allowWriteIn ?? true);
}

export function questionHeading(question: Question, askerLabel: string): string {
  switch (question.intent?.kind) {
    case 'npm-install-approval':
      return 'npm package approval';
    case 'command-approval':
      return 'Command approval';
    case 'tool-permission':
      return 'Tool permission';
    case 'toolset-install-approval':
      return 'Toolset install approval';
    case 'image-generation-approval':
      return 'Image generation approval';
    case 'video-generation-approval':
      return 'Video generation approval';
    case 'schedule-approval':
      return 'Schedule approval';
    default:
      return `${askerLabel} asks`;
  }
}

/** Accept both the current batch intent and legacy single-package records. */
export function npmApprovalPackages(question: Question): NpmInstallApprovalPackage[] {
  if (question.intent?.kind !== 'npm-install-approval') return [];
  const intent = question.intent as unknown as {
    packages?: NpmInstallApprovalPackage[];
    package?: string;
    version?: string;
  };
  if (Array.isArray(intent.packages) && intent.packages.length > 0) return intent.packages;
  if (intent.package && intent.version) {
    return [{ package: intent.package, version: intent.version }];
  }
  return [];
}

export function questionOptionCount(question: Question): number {
  if (question.intent?.kind === 'npm-install-approval') {
    return npmApprovalPackages(question).length > 0 ? 3 : 1;
  }
  const choices = choicesForQuestion(question).length;
  const writeIn = allowsWriteIn(question);
  const submit = question.multiSelect === true && choices > 0;
  return choices + (writeIn ? 1 : 0) + (submit ? 1 : 0);
}
