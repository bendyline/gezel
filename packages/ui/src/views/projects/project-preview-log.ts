import type { HtmlPreviewLogEntry } from '../../components/HtmlPreviewFrame.js';

export function formatPreviewLog(entry: HtmlPreviewLogEntry): string {
  if (entry.kind === 'console.error') {
    return (entry.detail.args ?? []).join(' ');
  }
  return entry.detail.message ?? '(unknown error)';
}

/** Build the user-facing chat message for an error raised by an HTML preview. */
export function formatPreviewComplaint(
  entry: HtmlPreviewLogEntry,
  file: { path: string; source: 'workspace' | 'artifacts' },
): string {
  const lines: string[] = [];
  lines.push(
    `I was previewing \`${file.source}/${file.path}\` and the browser surfaced a JavaScript error.`,
  );
  lines.push('');
  lines.push(`- **Kind:** ${entry.kind}`);
  const message = formatPreviewLog(entry);
  if (message) lines.push(`- **Message:** ${message}`);
  if (entry.detail.filename) {
    const location = [
      entry.detail.filename,
      entry.detail.lineno ? String(entry.detail.lineno) : null,
      entry.detail.colno ? String(entry.detail.colno) : null,
    ]
      .filter(Boolean)
      .join(':');
    lines.push(`- **Location:** ${location}`);
  }
  if (entry.url) lines.push(`- **Preview URL:** ${entry.url}`);
  if (entry.detail.stack) {
    lines.push('');
    lines.push('Stack trace:');
    lines.push('```');
    lines.push(entry.detail.stack);
    lines.push('```');
  }
  lines.push('');
  lines.push(
    "Can you take a look and figure out what's going wrong? Feel free to edit the file directly.",
  );
  return lines.join('\n');
}
