/**
 * Session-scoped registry of files a gezel has declared to be mid-edit.
 *
 * Every surgical edit tool validates the *whole file* after it writes,
 * and refuses the edit if the result does not parse. That is right for a
 * one-shot edit — it is what stops a truncated write from replacing a
 * working file. It is wrong for a model that is deliberately building a
 * large script across several inserts, because every intermediate state
 * is unparseable by construction, so the sequence can never make
 * progress: each edit is rejected and rolled back in turn.
 *
 * Wild-caught on the vampire-survivors session. A `write_file` carrying
 * the whole game hit the model's output ceiling and was correctly
 * discarded; the retry emitted a complete HTML shell with the engine
 * missing entirely; the model then tried to rebuild the engine in parts,
 * planting `/* ===SPAWN-END=== *​/` as a resume marker for part two.
 * Both attempts were rejected because a half-written script does not
 * parse, and it had no route to a file larger than one turn's output.
 *
 * The distinction a per-edit gate cannot make is not "is this edit
 * valid" but "did the model close the sequence". So the gate moves to a
 * boundary: `partial: true` opts a path into draft state, edits stop
 * being validated, and the assertions that declare work finished are
 * blocked until the file parses again.
 *
 * What draft state deliberately does NOT do is protect the previous
 * contents. Opting in means accepting that the last complete version is
 * being replaced in pieces — that is the whole point. {@link CAP} bounds
 * the blast radius for a model that sets the flag reflexively: past that
 * many provisional edits the sequence is abandoned and the pre-draft
 * content is restored.
 */

/**
 * Provisional edits allowed before a sequence is abandoned and rolled
 * back. A genuine multi-part build lands in a handful of inserts; a
 * model thrashing on a file it cannot fix does not converge, and ending
 * that with a working file beats ending it with a broken one.
 */
export const CAP = 12;

export interface DraftSequence {
  path: string;
  /** Provisional edits applied so far. */
  edits: number;
  /** File contents immediately before the first provisional edit. */
  snapshot: string;
}

/** Assertions that declare work finished. Refused while a draft is open. */
const GATED_TOOLS: ReadonlySet<string> = new Set(['advance_task_step', 'verify_outcome']);

export class PartialEditRegistry {
  private readonly drafts = new Map<string, DraftSequence>();

  /**
   * Record a provisional edit. `priorContent` is only kept the first
   * time — it is the last state the file was in before the sequence
   * started, not the previous provisional step.
   */
  record(path: string, priorContent: string): DraftSequence {
    const existing = this.drafts.get(path);
    if (existing) {
      existing.edits += 1;
      return existing;
    }
    const created: DraftSequence = { path, edits: 1, snapshot: priorContent };
    this.drafts.set(path, created);
    return created;
  }

  get(path: string): DraftSequence | undefined {
    return this.drafts.get(path);
  }

  isOpen(path: string): boolean {
    return this.drafts.has(path);
  }

  /** Called when a path validates cleanly again, by any write path. */
  close(path: string): DraftSequence | undefined {
    const draft = this.drafts.get(path);
    if (draft) this.drafts.delete(path);
    return draft;
  }

  openPaths(): string[] {
    return [...this.drafts.keys()].sort();
  }

  /**
   * Why `toolName` may not run, or null. Mirrors the unresolved-tool
   * failure ledger: narrow set of gated tools, and `set_task_status`
   * stays open so a stuck gezel keeps an honest exit.
   */
  blockReason(toolName: string): string | null {
    if (!GATED_TOOLS.has(toolName)) return null;
    const open = this.openPaths();
    if (open.length === 0) return null;
    const list = open.map((p) => `\`${p}\``).join(', ');
    return [
      `${toolName} is blocked: ${open.length === 1 ? 'a file is' : 'files are'} still in a provisional edit sequence (${list}).`,
      'Those edits were accepted without the syntax gate because you passed `partial: true`, so the file is not known to parse.',
      'Finish the sequence with a final edit that omits `partial`, or re-emit the whole file with `write_file`.',
      `Then re-run \`validate\` and call ${toolName} again.`,
    ].join(' ');
  }

  /** Model-facing note appended to a provisional edit's result. */
  noticeFor(draft: DraftSequence): string {
    const left = CAP - draft.edits;
    const parts = [
      `[Provisional edit ${draft.edits} of at most ${CAP}] \`${draft.path}\` is a draft and was NOT syntax-checked.`,
      'Nothing that declares work finished will run until it parses again.',
      `Close the sequence with a final edit that omits \`partial\`, then call \`validate({ path: "${draft.path}" })\`.`,
    ];
    if (left <= 3) {
      parts.push(`Only ${left} provisional edit(s) remain before the sequence is reverted.`);
    }
    return `\n\n${parts.join(' ')}`;
  }
}
