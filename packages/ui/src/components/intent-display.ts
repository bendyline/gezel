/**
 * Provider implementation breadcrumbs such as "Using MCP tool call"
 * duplicate the concrete tool row directly below them. Keep meaningful
 * phase announcements ("Reviewing the final draft") while hiding old
 * persisted noise and guarding against future client regressions.
 */
export function shouldDisplayIntent(label: string): boolean {
  const normalized = label.trim();
  if (normalized.length === 0) return false;
  if (/^(?:using|calling|executing)\b/i.test(normalized)) return false;
  return !/^(?:reasoning|thinking|preparing|streaming)$/i.test(normalized);
}
