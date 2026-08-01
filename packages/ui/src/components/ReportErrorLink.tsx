import { useState } from 'react';
import type { ErrorReportInput } from '../error-report.js';
import { ReportErrorDialog } from './ReportErrorDialog.js';

/**
 * The affordance beside a clear system error. Belongs where the app itself
 * failed — an engine crash, a tab that would not render, a background service
 * that never came up — not next to ordinary validation messages the user can
 * fix themselves.
 *
 * `className` rather than a variant enum: the three shapes the hosts need
 * already have classes, and a variant enum would only be a lookup table onto
 * those same three. The default suits an inline link inside a red banner;
 * neutral surfaces pass `home-link`, action rows pass their own button class.
 */
export function ReportErrorLink({
  report,
  label = 'Report error on GitHub…',
  className = 'timeline-session-error-link',
  title,
}: {
  report: ErrorReportInput;
  label?: string;
  className?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} title={title} onClick={() => setOpen(true)}>
        {label}
      </button>
      {/* Mounted only once asked: the chat hosts re-render per streamed
          token, and an always-mounted dialog would fetch diagnostics for
          every failed turn nobody ever reports. */}
      {open && <ReportErrorDialog open={open} report={report} onClose={() => setOpen(false)} />}
    </>
  );
}
