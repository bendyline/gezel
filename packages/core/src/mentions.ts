/**
 * Shared parser for gezel @-mention markdown.
 *
 * The composer writes mentions as `@[Label](gezel:id)` and may append a
 * `?project=<projectId>` routing suffix to the id. The service receives the
 * raw id over the chat-session wire shape, so UI and service must agree on
 * the split rules.
 */

export interface GezelMentionToken {
  /** Bare gezel id, without an optional `?project=...` suffix. */
  id: string;
  /** Display label as written in the markdown brackets. */
  label: string;
  /** Full id as it appears between `gezel:` and `)`. */
  rawId: string;
  /** Project routing override decoded from the suffix, if present. */
  projectId?: string;
}

export function extractGezelMentions(markdown: string): string[] {
  return extractGezelMentionTokens(markdown).map((m) => m.rawId);
}

export function extractGezelMentionTokens(markdown: string): GezelMentionToken[] {
  const out: GezelMentionToken[] = [];
  const seen = new Set<string>();
  const re = /@\[([^\]]+)\]\(gezel\\?:([^)\s]+)\)/g;
  for (const m of markdown.matchAll(re)) {
    const label = m[1];
    const rawId = m[2];
    if (!rawId || !label || seen.has(rawId)) continue;
    seen.add(rawId);
    const { gezelId, projectId } = parseGezelMentionId(rawId);
    out.push({ id: gezelId, label, rawId, ...(projectId ? { projectId } : {}) });
  }
  return out;
}

export function parseGezelMentionId(rawId: string): {
  gezelId: string;
  projectId?: string;
} {
  if (!rawId) return { gezelId: '' };
  const q = rawId.indexOf('?');
  if (q < 0) return { gezelId: rawId };
  const gezelId = rawId.slice(0, q);
  const params = new URLSearchParams(rawId.slice(q + 1));
  const projectId = params.get('project') ?? undefined;
  return projectId ? { gezelId, projectId } : { gezelId };
}

export function stripGezelMentions(text: string): string {
  if (!text) return text;
  const cleaned = text.replace(/@\[[^\]]+\]\(gezel\\?:[^)\s]+\)/g, '');
  return cleaned.replace(/\s+/g, ' ').trim();
}
