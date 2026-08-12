// Browser-facing compatibility facade. Report composition and privacy
// scrubbing live in core so every process uses the same outbound contract.
export {
  DEFAULT_ISSUE_LABELS,
  type ErrorReportInput,
  type ErrorReportSurface,
  URL_BUDGET_DEFAULT,
  URL_BUDGET_WIN32,
  buildIssueUrl,
  deriveIssueTitle,
  fitIssueUrl,
  formatErrorReport,
  isUserCancelledTurnError,
  reportCursorOffset,
} from '@bendyline/gezel';
