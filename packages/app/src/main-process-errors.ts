import {
  type ErrorReportInput,
  type FatalProcessErrorSource,
  URL_BUDGET_DEFAULT,
  URL_BUDGET_WIN32,
  deriveIssueTitle,
  fitIssueUrl,
  formatErrorReport,
  redactSensitive,
} from '@bendyline/gezel';

export interface MainProcessIssueInput {
  error: Error;
  source: FatalProcessErrorSource;
  version: string;
  electronVersion: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
}

/**
 * Public issue text gets a stricter scrub than local logs. In particular,
 * remove every absolute path, including app-install paths that do not contain
 * a username and therefore are intentionally retained by `redactSensitive`.
 */
export function scrubMainProcessErrorText(text: string): string {
  return (
    redactSensitive(text)
      // Quoted paths may contain spaces and need to be removed before the
      // conservative unquoted fallback below stops at its first space.
      .replace(/(?:file:\/{2,3})?[A-Za-z]:[\\/][^\r\n"'`)]+(?=["'`)])/gi, '<path>')
      .replace(/(^|[\s("'`])\/(?:[^/\r\n"'`)]+\/)+[^\r\n"'`)]+(?=["'`)])/gm, '$1<path>')
      // Unquoted stack frames conventionally end in a file extension, optional
      // line/column, then whitespace or a closing parenthesis. This safely spans
      // install folders such as "Program Files" without eating the next phrase.
      .replace(
        /(?:file:\/{2,3})?[A-Za-z]:[\\/](?:[^\\/\r\n"'`)]+[\\/])*[^\\/\r\n"'`)]*\.[A-Za-z0-9]{1,12}(?=:\d|[\s"'`),]|$)/gi,
        '<path>',
      )
      .replace(
        /(^|[\s("'`])\/(?:[^/\r\n"'`)]+\/)*[^/\r\n"'`)]*\.[A-Za-z0-9]{1,12}(?=:\d|[\s"'`),]|$)/gm,
        '$1<path>',
      )
      .replace(/(?:file:\/{2,3})?[A-Za-z]:[\\/][^\s"'`)]+/gi, '<path>')
      .replace(/(^|[\s("'`])\/(?:[^/\s"'`)]+\/)+[^\s"'`)]+/gm, '$1<path>')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function errorSummary(error: Error): string {
  const summary = scrubMainProcessErrorText(error.message || error.name);
  return summary.length > 500 ? `${summary.slice(0, 499).trimEnd()}…` : summary;
}

/** Build an editable GitHub issue URL that is safe for the OS shell boundary. */
export function mainProcessIssueUrl(input: MainProcessIssueInput): string {
  const report: ErrorReportInput = {
    surface: 'main-process',
    message: errorSummary(input.error) || 'An unexpected main-process error occurred.',
    detail: {
      code: 'main-process',
      diagnostics: {
        source: input.source,
        app: input.version,
        electron: input.electronVersion,
        node: input.nodeVersion,
        platform: `${input.platform} ${input.arch}`,
      },
    },
  };
  return fitIssueUrl({
    title: deriveIssueTitle(report),
    body: formatErrorReport(report),
    maxUrlLength: input.platform === 'win32' ? URL_BUDGET_WIN32 : URL_BUDGET_DEFAULT,
  }).url;
}
