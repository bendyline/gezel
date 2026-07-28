import type { PreviewLogEntry } from '@bendyline/gezel';

/**
 * In-memory, daemon-lifetime buffer of runtime errors the preview iframe's
 * injected log shim observed on project pages. The UI already captures
 * these (HtmlPreviewFrame → preview route shim) but until now they died in
 * a side drawer the gezel never sees — the user stares at a dark page the
 * model believes is finished. The loopback: the UI posts entries here, and
 * ChatManager drains them into a bracketed prelude on the next send scoped
 * to the project, so the model hears "the live preview threw X" without
 * anyone pasting console output.
 *
 * Deliberately ephemeral (not a Store carve-out): this is diagnostics
 * signal, not user state. A daemon restart dropping it costs one nudge.
 *
 * Drain semantics: first send in the project consumes the pending set —
 * with multiple gezels chatting concurrently in one project, whichever
 * turn lands first delivers the news. Good enough for the MVP; the
 * alternative (per-session cursors) buys little for the bookkeeping.
 */
export class PreviewLogBuffer {
  private readonly perProject = new Map<string, PreviewLogEntry[]>();
  private readonly cap: number;

  constructor(opts: { cap?: number } = {}) {
    this.cap = opts.cap ?? 50;
  }

  record(projectId: string, entries: PreviewLogEntry[]): void {
    if (entries.length === 0) return;
    const existing = this.perProject.get(projectId) ?? [];
    for (const entry of entries) {
      // Collapse exact repeats (a console.error inside a loop) — the model
      // needs the distinct failure, not four hundred copies of it.
      const dup = existing.some(
        (e) => e.path === entry.path && e.kind === entry.kind && e.message === entry.message,
      );
      if (!dup) existing.push(entry);
    }
    this.perProject.set(projectId, existing.slice(-this.cap));
  }

  /** Return pending entries for the project and clear them. */
  drain(projectId: string): PreviewLogEntry[] {
    const entries = this.perProject.get(projectId) ?? [];
    this.perProject.delete(projectId);
    return entries;
  }

  pendingCount(projectId: string): number {
    return this.perProject.get(projectId)?.length ?? 0;
  }
}

/** Max distinct errors surfaced in one prelude block. */
const MAX_PRELUDE_ERRORS = 4;

/**
 * Format drained entries as the bracketed user-message prelude. Rendered
 * ahead of the user's text (never into the system prompt — a changing
 * system block would churn the stable-prefix KV cache that DS4-class
 * engines depend on). Shape matches the "runtime nudge" contract the
 * model-profile prompts already teach: name the failure, point at the
 * surgical fix.
 */
export function formatPreviewLogPrelude(entries: PreviewLogEntry[]): string | null {
  if (entries.length === 0) return null;
  const lines = entries
    .slice(-MAX_PRELUDE_ERRORS)
    .map((e) => `- ${e.path}: ${e.kind === 'error' ? 'pageerror' : e.kind}: ${e.message}`);
  const omitted = entries.length - Math.min(entries.length, MAX_PRELUDE_ERRORS);
  const omittedSuffix = omitted > 0 ? `\n(+${omitted} more)` : '';
  return `[Live preview reported runtime errors on this project's pages since the last turn:\n${lines.join('\n')}${omittedSuffix}\nIf these relate to files you own, fix the offending lines with replace_in_file — do not rewrite whole files.]`;
}
