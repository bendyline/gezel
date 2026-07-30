import type { ChatManager } from '../chat/manager.js';

/**
 * One-shot AI helpers for the GitHub tab: a save-description suggestion
 * from the current diff, and a proposed three-way merge for one
 * conflicted file. Both are previews — nothing here writes to the repo;
 * the route returns text and the UI applies it through the normal
 * commit / resolve endpoints.
 */

/** Diff text beyond this is head-truncated before prompting. */
const MAX_SUGGEST_DIFF_CHARS = 30_000;

/** Combined base+ours+theirs payload cap for merge proposals. */
const MAX_MERGE_PAYLOAD_CHARS = 48_000;

export class FileTooLargeForAiError extends Error {
  constructor(path: string) {
    super(`${path} is too large for AI to combine — pick one version or edit it by hand.`);
    this.name = 'FileTooLargeForAiError';
  }
}

/** Plain-language one-liner describing the working-tree changes. */
export async function suggestCommitMessage(
  chat: ChatManager,
  args: { diff: string; changedPaths: string[] },
): Promise<string> {
  const diff =
    args.diff.length > MAX_SUGGEST_DIFF_CHARS
      ? `${args.diff.slice(0, MAX_SUGGEST_DIFF_CHARS)}\n[…diff truncated]`
      : args.diff;
  const prompt = [
    'Write a one-line description of the file changes below, as a save note a',
    'non-technical user would write for themselves.',
    '',
    'Rules:',
    '- ONE plain-English sentence, at most ~12 words.',
    '- Describe WHAT changed in the content, not which files were touched.',
    '- No commit-message conventions: no "feat:"/"fix:" prefixes, no imperative-mood jargon.',
    '- Return ONLY the sentence — no quotes, no code fences, no preamble.',
    '',
    `Changed files: ${args.changedPaths.join(', ')}`,
    '',
    'Diff:',
    diff,
  ].join('\n');
  const raw = await chat.oneShotCompletion(prompt, 60_000, {
    jobLabel: 'github · suggest save note',
  });
  return stripDecorations(raw);
}

/**
 * Propose merged content for one conflicted file from its three
 * versions. Returns the full merged file text; throws when the model
 * doesn't produce a parseable result so the UI falls back to manual.
 */
export async function proposeMergeResolution(
  chat: ChatManager,
  args: { path: string; base?: string; ours: string; theirs: string },
): Promise<string> {
  const payload = (args.base ?? '').length + args.ours.length + args.theirs.length;
  if (payload > MAX_MERGE_PAYLOAD_CHARS) throw new FileTooLargeForAiError(args.path);
  const prompt = [
    `Two people edited the same file (${args.path}) and their changes overlap.`,
    'Combine both sets of changes into one coherent file. Keep BOTH intents',
    'wherever they do not contradict; when they truly conflict, prefer the',
    'change that keeps the file consistent with itself.',
    '',
    'Output contract: return ONLY the complete merged file inside a single',
    '```merged code fence. No explanation before or after.',
    '',
    ...(args.base !== undefined
      ? ['<base — the version both started from>', args.base, '</base>', '']
      : []),
    '<yours — the local version>',
    args.ours,
    '</yours>',
    '',
    '<from-github — the remote version>',
    args.theirs,
    '</from-github>',
  ].join('\n');
  const raw = await chat.oneShotCompletion(prompt, 120_000, {
    jobLabel: `github · combine ${args.path}`,
  });
  const fence = raw.match(/```(?:merged|[a-z]*)?\s*\n([\s\S]*?)\n?```/);
  if (!fence || fence[1] === undefined) {
    throw new Error('AI did not return a combined file — pick one version or edit it by hand.');
  }
  return fence[1];
}

/** Strip wrapping quotes/fences a model sometimes adds despite the rules. */
function stripDecorations(text: string): string {
  let out = text.trim();
  const fenced = out.match(/^```[a-z]*\s*\n([\s\S]*?)\n```$/);
  if (fenced && fenced[1] !== undefined) out = fenced[1].trim();
  // One line only — take the first non-empty line if the model rambled —
  // BEFORE quote-stripping, so a quoted first line still loses its quotes.
  out = (out.split('\n').find((l) => l.trim().length > 0) ?? '').trim();
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) {
    out = out.slice(1, -1).trim();
  }
  return out;
}
