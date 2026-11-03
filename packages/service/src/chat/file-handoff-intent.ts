import { createHash } from 'node:crypto';
import type { Store } from '../fs/store.js';

/**
 * Does this inbound message ask the recipient to MODIFY / change existing
 * content, as opposed to create a file from scratch? Used by the chat
 * manager to refuse to short-circuit a real change request just because it
 * names an already-existing file.
 *
 * The bias is deliberate and asymmetric: a false positive here only costs a
 * short-circuit optimization (the developer's LLM runs and the downstream
 * no-op / workspace-collision guards absorb a genuinely redundant create),
 * whereas a false negative silently DROPS real work — the exact failure this
 * guards against. So ambiguous create/modify verbs ("add", "implement",
 * "include") count as modify, and any behavioral-delta phrasing ("so that
 * …", "instead of …", "when an alien reaches …") trips it. The cost is that
 * a verbose create spec that happens to say "add a Play Again button" or
 * "spawn a wave when the timer fires" also bails to the LLM — acceptable,
 * since that path is safe and the loop-breaking the short-circuit existed
 * for is now also covered by the scheduler's busy-assignee skip and task
 * status. Wild-caught (qwen3.6 "Space Shooter Arcade").
 */
export function messageExpressesModifyIntent(text: string): boolean {
  return (
    // Verbs that act on something that already exists. Includes the
    // ambiguous create/modify set (add|implement|include|introduce|support)
    // on purpose — see the bias note above.
    /\b(updat\w*|modif\w*|chang\w*|edit\w*|adjust\w*|tweak\w*|fix\w*|patch\w*|refactor\w*|renam\w*|replac\w*|remov\w*|delet\w*|subtract\w*|deduct\w*|decrement\w*|increment\w*|increas\w*|decreas\w*|reduc\w*|penali[sz]\w*|add(?:s|ed|ing)?|implement\w*|includ\w*|introduc\w*|support\w*)\b/i.test(
      text,
    ) ||
    // Behavioral-delta phrasing — changing how something already behaves
    // rather than describing a whole new artifact.
    /\bso\s+(?:that|when)\b/i.test(text) ||
    /\bmake\s+it\s+so\b/i.test(text) ||
    /\b(?:instead\s+of|rather\s+than)\b/i.test(text) ||
    /\bshould\s+(?:now|instead|also)\b/i.test(text) ||
    /\bcurrently\b/i.test(text) ||
    // An event trigger on existing gameplay/behavior ("when an alien reaches
    // the bottom", "when the ship hits an enemy") is a change, not a create.
    /\bwhen\s+(?:a|an|the|each|any|every)?\s*[\w-]+\s+(?:reach\w*|hit\w*|land\w*|cross\w*|touch\w*|press\w*|click\w*|collid\w*|die\w*|spawn\w*|enter\w*|leav\w*|escap\w*|destroy\w*)\b/i.test(
      text,
    )
  );
}

/**
 * Preserve create-request deduplication while keeping concrete repairs from
 * being swallowed by an older in-flight create for the same path. Distinct
 * repair verdicts get distinct keys; byte-identical/reformatted retries still
 * join one live handoff.
 */
export function fileHandoffIntentKey(text: string): string {
  const repair =
    messageExpressesModifyIntent(text) ||
    /\[scenario check\]|\b(?:specific failure|signals? that (?:didn't|did not) fire|success criteria (?:aren't|are not) met|repeat miss|gate_full_rewrite|rejected)\b/i.test(
      text,
    );
  if (!repair) return 'create';
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return `repair:${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`;
}

export function isSubstantiveExistingWorkspaceFile(filePath: string, content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (/\.html?$/i.test(filePath)) {
    return trimmed.length >= 500 && /<script\b/i.test(trimmed) && /<(?:html|body)\b/i.test(trimmed);
  }
  return true;
}

/**
 * The workspace file a handoff asks to create although it already exists
 * with real content, so the request can be answered as delivered instead of
 * re-run; null when the request is real work.
 */
export async function staleWorkspaceFileRequest(
  store: Pick<Store, 'readProjectWorkspaceFile'>,
  projectId: string,
  userText: string,
): Promise<string | null> {
  const explicitMissingFileMatch = userText.match(
    /there is still\s+\*?\*?no\s+`([^`]+)`\*?\*?\s+in the workspace/i,
  );
  const explicitMissingFilePath = explicitMissingFileMatch?.[1]?.trim();
  if (explicitMissingFilePath) {
    try {
      const content = await store.readProjectWorkspaceFile(projectId, explicitMissingFilePath);
      return content !== null &&
        isSubstantiveExistingWorkspaceFile(explicitMissingFilePath, content)
        ? explicitMissingFilePath
        : null;
    } catch {
      return null;
    }
  }

  // A request to MODIFY an existing file ("update index.html so an alien
  // reaching the bottom subtracts 50 points") names the same path a
  // redundant "create it" request would — but it is real work, not a
  // no-op. Never short-circuit it. Without this guard the change is
  // silently dropped: the recipient's turn is skipped entirely and the
  // synthetic "treat as delivered" reply tells the voorman to close the
  // task. Wild-caught (qwen3.6 voorman "Space Shooter Arcade"): a
  // "subtract 50 points" change handoff was eaten here because it
  // mentioned `workspace/index.html` and the file already existed.
  if (messageExpressesModifyIntent(userText)) return null;

  const text = userText.trim();
  const isQueuedGezelMessage = /^\[Message from [^\]]+\]:/i.test(text);
  const isRepairMessage =
    /\bworking-image\b/i.test(text) ||
    /\bsuccess criteria\b/i.test(text) ||
    /\breplace_in_file\b/i.test(text) ||
    /\bpatch\b[\s\S]{0,160}\b(?:img|image|src)\b/i.test(text);
  if (!isQueuedGezelMessage || isRepairMessage) return null;
  const filePath =
    text.match(/\[Deliverable expected as a FILE at `([^`]+)`/i)?.[1]?.trim() ??
    text.match(/\bworkspace\/(index\.html)\b/i)?.[1]?.trim();
  if (!filePath) return null;
  try {
    const content = await store.readProjectWorkspaceFile(projectId, filePath);
    return content !== null && isSubstantiveExistingWorkspaceFile(filePath, content)
      ? filePath
      : null;
  } catch {
    return null;
  }
}
