/**
 * Runtime-check feedback loop — closes the gap between the eval harness's
 * Playwright runtime layer and the model's chat session.
 *
 * Before this module: when the runtime check rejected an artifact
 * (e.g. "DOM signature unchanged after ArrowRight + Space" on
 * tankcombat), the failure was logged to the trial's log.txt and the
 * trial kept polling — but the model had no signal that its artifact
 * was rejected for a specific reason. The matrices #5 and #6
 * both reproduced the same fingerprint on tankcombat: the model wrote
 * three 9–10 KB tank games in succession, each with the same runtime
 * failure, because every rewrite was blind to the previous one's
 * specific defect.
 *
 * This module posts a from-Meester message naming the failed assertion(s)
 * verbatim into the most recently-active non-meester gezel session. The
 * model sees "**keyboard-listener-installed**: DOM signature unchanged
 * after ArrowRight + Space" the next time it reads its inbox and can
 * patch the specific handler instead of rewriting the whole file blind.
 *
 * Dedup is the load-bearing detail. The success-check polls every 5 s;
 * without dedup the same nudge would fire ~500 times across a 45-min
 * petshop or 25-min tankcombat trial, drowning the chat history. We
 * hash `(filePath, sorted-failed-assertion-names)` and only nudge when
 * that hash changes — i.e., the model wrote new code and we have a
 * *new* failure set.
 */

import type { RuntimeReport } from './html-validation.ts';
import type { EvalContext } from './types.ts';

/**
 * Per-context cache: hashKey → number of nudges posted with that key.
 * The number drives escalation language ("this is your 3rd attempt").
 * WeakMap so garbage collection cleans up when the trial's
 * EvalContext goes out of scope at end-of-trial.
 */
const nudgeMemory = new WeakMap<EvalContext, Map<string, number>>();

interface RuntimeFeedbackOptions {
  expectedDeliverable?: { kind: 'file'; filePath: string } | null;
  extraInstruction?: string;
  /** Project containing filePath; lets feedback route to its actual last writer. */
  projectId?: string;
}

/**
 * Hash the (file, failure-set, file-fingerprint) tuple. The original
 * implementation hashed only (filePath, failed-names) — that worked
 * for "don't re-nudge while the model is still on the same attempt"
 * but ALSO suppressed the nudge across successive file rewrites that
 * each kept failing the same assertion. The copilot
 * tankcombat trial reproduced this: Sonnet got one nudge at minute 4
 * for `keyboard-listener-installed`, rewrote the file 50 times across
 * the next 21 minutes (each rewrite still failing the same
 * assertion), and never got a second nudge because the dedup hash
 * was constant. Adding a content fingerprint means a rewrite-that-
 * still-fails triggers a fresh "you tried again, same problem" nudge.
 */
function hashFailureSet(
  filePath: string,
  report: RuntimeReport,
  contentFingerprint: string,
): string {
  const names = report.failed
    .map((f) => f.name)
    .sort()
    .join(',');
  return `${filePath}::${names}::${contentFingerprint}`;
}

/**
 * Cheap content fingerprint — first 4 KB hashed to base36. We don't
 * need cryptographic collision resistance; we just need a value that
 * changes when the model rewrites the file. Hashing the whole file
 * on every 5-s poll would burn cycles on large artifacts (squisq-
 * review's 24 KB review, petshop's growing HTML); the first 4 KB
 * captures the part most likely to change on edits and is bounded.
 */
function fingerprintContent(text: string): string {
  const head = text.length > 4096 ? text.slice(0, 4096) : text;
  let h = 0x811c9dc5;
  for (let i = 0; i < head.length; i++) {
    h ^= head.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(36)}-${text.length}`;
}

/**
 * When a scenario's runtime layer rejects an artifact, post a from-Meester
 * message to the most recently-active non-meester chat session naming the
 * failed assertion(s) verbatim. No-op when:
 *
 *   - The runtime didn't run (Playwright bootstrap failure — see
 *     `helpers.ts`'s "runtime layer unavailable" branch).
 *   - No assertions failed (only `passed` is non-empty).
 *   - We've already posted a nudge for this exact (filePath, failed-names)
 *     combo since the trial started (dedup).
 *   - No non-meester session is active yet (trial too early in kickoff
 *     — the meester hasn't handed off).
 */
export async function postRuntimeFeedback(
  ctx: EvalContext,
  filePath: string,
  report: RuntimeReport,
  /**
   * The current file content. Used to fingerprint "the team rewrote
   * the file" so we re-nudge on each rewrite that still fails the
   * same assertion. Optional for back-compat; when omitted, falls
   * back to the old behaviour (one nudge per failure set per trial).
   */
  fileContent?: string,
  options: RuntimeFeedbackOptions = {},
): Promise<void> {
  if (!report.ran || report.failed.length === 0) return;

  let posted = nudgeMemory.get(ctx);
  if (!posted) {
    posted = new Map();
    nudgeMemory.set(ctx, posted);
  }
  const fingerprint = fileContent !== undefined ? fingerprintContent(fileContent) : 'no-content';
  const key = hashFailureSet(filePath, report, fingerprint);
  if (posted.has(key)) return;

  // Count how many DISTINCT rewrites we've nudged about for the same
  // (filePath, failed-names) prefix. Escalation language kicks in
  // after 2 — "still failing after N rewrites; try a fundamentally
  // different approach" — to help the model break out of a loop.
  const prefix = `${filePath}::${report.failed
    .map((f) => f.name)
    .sort()
    .join(',')}::`;
  let priorAttempts = 0;
  for (const seenKey of posted.keys()) {
    if (seenKey.startsWith(prefix)) priorAttempts++;
  }
  const attemptNum = priorAttempts + 1;

  const target = await pickTargetGezel(ctx, filePath, options.projectId);
  if (!target) {
    ctx.log(`[runtime-feedback] no non-meester session active yet; skipping nudge for ${filePath}`);
    return;
  }

  const text = formatNudge(filePath, report, attemptNum, fileContent, options.extraInstruction);
  const expectedDeliverable =
    options.expectedDeliverable === undefined
      ? ({ kind: 'file', filePath } as const)
      : options.expectedDeliverable;
  try {
    await ctx.client.messageGezel(target.gezelId, {
      fromGezelId: ctx.meesterId,
      text,
      suppressReply: true,
      ...(expectedDeliverable ? { expectedDeliverable } : {}),
      ...(target.projectId ? { projectId: target.projectId } : {}),
    });
    posted.set(key, attemptNum);
    ctx.log(
      `[runtime-feedback] nudged ${target.gezelId} about ${filePath} runtime failures (attempt ${attemptNum}): ${report.failed
        .map((f) => f.name)
        .join(', ')}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log(`[runtime-feedback] messageGezel failed for ${target.gezelId}: ${msg}`);
  }
}

/**
 * Render the failure into a message the model can act on. The format
 * deliberately mirrors compiler error output: failed assertion names
 * in bold, the verbatim "why" string from the runtime report, and a
 * single sentence telling the model what to do next + which tool to
 * use. We name `validate` as the self-check tool to close the loop
 * with the verification gate.
 */
function formatNudge(
  filePath: string,
  report: RuntimeReport,
  attemptNum: number,
  fileContent?: string,
  extraInstruction?: string,
): string {
  const failedSummary = report.failed.map((f) => `- **${f.name}**: ${f.why}`).join('\n');
  const keyboardCanvasHint = report.failed.some((f) => f.name === 'keyboard-listener-installed')
    ? '\nFor canvas-only games, key presses may only change pixels. Make input observable too: attach your state with `window.gameState = gameState` / `window.player = player`, or increment `document.body.dataset.inputTick` inside the keydown handler.'
    : '';
  const seedTasksRenderHint = report.failed.some((f) => f.name === 'seed-tasks-render')
    ? '\nFor seed-task render failures, make the first render happen immediately from the entrypoint after the DOM nodes are available. Do not only register it inside a later `window.load` handler from within `DOMContentLoaded`; the load event may already be missed. Call the render/init function directly, then re-render after add/filter/status changes.'
    : '';
  const ticTacToeCellHint = formatTicTacToeCellRepairHint(filePath, report, fileContent);
  const ticTacToeRepairHint = formatTicTacToeRuntimeRepairHint(filePath, report);
  const hasTicTacToeRepairHint = ticTacToeRepairHint !== '';
  const pageErrorRepairHint = formatPageErrorRepairHint(filePath, report, fileContent);
  const pageErrorsLine = report.pageErrors.length
    ? `\nBrowser console reported ${report.pageErrors.length} page error(s) — first: ${report.pageErrors[0]?.slice(0, 200) ?? '(empty)'}`
    : '';
  const extraInstructionLine = extraInstruction ? `\n${extraInstruction}` : '';
  const passedLine =
    report.passed.length > 0
      ? `(${report.passed.length} other assertion(s) passed: ${report.passed.join(', ')})`
      : '';
  const localImageRepairHint = report.failed.some(
    (f) => f.name === 'all-rendered-local-images-resolve',
  )
    ? '\nFor unresolved local images, do not invent more filenames. Use `list_dir` on the workspace assets directory, keep `<img src>` references only for real files that exist, and patch/remove every unresolved reference. If the page requires one generated logo, preserve that real logo and use CSS placeholders for decorative product cards instead of fake JPG/PNG paths.'
    : '';

  // Escalation language. First nudge: factual, here's what failed.
  // 2nd–3rd: "you rewrote it but the same assertion still fails —
  // your previous patch missed the cause." 4th+: "stop rewriting and
  // try a fundamentally different approach" — the same fix shape
  // clearly isn't working.
  const header =
    attemptNum === 1
      ? `[runtime check] I opened \`${filePath}\` in a headless browser. ${report.failed.length} assertion(s) failed:`
      : attemptNum <= 3
        ? `[runtime check — attempt ${attemptNum}] I re-opened \`${filePath}\` after your latest edit. The SAME assertion(s) are still failing:`
        : `[runtime check — attempt ${attemptNum}, STOP REWRITING] You've now rewritten \`${filePath}\` ${attemptNum - 1} time(s) and the SAME assertion(s) keep failing. Your current approach isn't fixing the cause. Failures:`;

  const tail = hasTicTacToeRepairHint
    ? '\nFollow the TICTACTOE_FULL_REWRITE instruction above exactly. The browser check will re-open the file after that write.'
    : attemptNum === 1
      ? `\nThe static structure looks correct (the sniff signals all fire) but the page doesn't actually function. Read \`${filePath}\`, find the specific code that should make the failing assertion(s) pass, and patch with \`replace_in_file\` (preferred for small fixes) or re-emit with \`write_file\`. Call \`validate({ path: "${filePath}" })\` to confirm syntactic shape before the next runtime check fires.`
      : attemptNum <= 3
        ? `\nYour previous edit didn't address the cause. Re-read \`${filePath}\` carefully — the failing assertion's "why" string above tells you exactly what the browser saw. The fix is almost certainly NOT another full rewrite; it's a targeted patch to the code path that should make the assertion pass. If you genuinely don't know what to change, ask the user for guidance via \`ask_user_question\` rather than guessing again.`
        : `\nDifferent rewrites with the same defect strongly suggest a misdiagnosis. Before any further edit: (1) read the failing assertion's "why" string above word-for-word, (2) open the existing file and find the SPECIFIC code that the assertion is checking, (3) write down what the code does today vs. what the assertion expects, (4) only then patch. If after that you still don't see the gap, escalate to the user with \`ask_user_question\` — the runtime check has been clear about what it wants.`;

  return [
    header,
    failedSummary,
    keyboardCanvasHint,
    seedTasksRenderHint,
    localImageRepairHint,
    extraInstructionLine,
    ticTacToeRepairHint,
    ticTacToeCellHint,
    pageErrorsLine,
    pageErrorRepairHint,
    passedLine ? `${passedLine}\n` : '',
    tail,
  ]
    .join('\n')
    .trim();
}

function formatTicTacToeRuntimeRepairHint(filePath: string, report: RuntimeReport): string {
  const failed = new Set(report.failed.map((f) => f.name));
  const isTicTacToePath = /(?:^|\/)tic-?tac-?toe(?:-|\/)|(?:^|\/)index\.html$/i.test(filePath);
  const isTicTacToeRuntimeShape =
    failed.has('nine-cells-rendered') ||
    failed.has('click-marks-a-cell') ||
    failed.has('win-detection');
  if (!isTicTacToePath || !isTicTacToeRuntimeShape) return '';

  return [
    '',
    'TICTACTOE_FULL_REWRITE: this page must be mechanically simple enough for the browser check to drive.',
    `Your next tool call MUST be \`write_file\` for \`${filePath}\`; do not call \`validate\`, \`read_file\`, \`ask_user_question\`, create another project, or delegate again before writing.`,
    'Replace the whole file with one self-contained HTML document that contains nine literal clickable elements in the HTML itself: `<button class="cell" data-cell="0"></button>` through `data-cell="8"`. Do not rely on JavaScript to create the cells.',
    'The click handler must set the clicked button text to `X` or `O` and leave it visible after the click. Keep a `board` array, toggle `currentPlayer`, check these exact win lines `[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]`, and update a visible status element when someone wins or the game draws.',
    'No external scripts, no framework, no generated cells, no placeholder board. One complete `write_file` call is the repair.',
  ].join('\n');
}

function formatTicTacToeCellRepairHint(
  filePath: string,
  report: RuntimeReport,
  fileContent: string | undefined,
): string {
  if (!fileContent) return '';
  const failedNames = new Set(report.failed.map((f) => f.name));
  if (!failedNames.has('nine-cells-rendered') && !failedNames.has('click-marks-a-cell')) {
    return '';
  }
  const emptyGridMatch = fileContent.match(
    /<div\b(?=[^>]*\bid=["']grid["'])(?=[^>]*\bclass=["'][^"']*\bgrid\b[^"']*["'])[^>]*>\s*<\/div>/i,
  );
  if (!emptyGridMatch?.[0]) return '';
  const existingCellElements =
    fileContent.match(/<(?:button|div|td)\b[^>]*\bclass=["'][^"']*\bcell\b[^"']*["'][^>]*>/gi)
      ?.length ?? 0;
  if (existingCellElements >= 9) return '';

  const replacement = [
    '<div class="grid" id="grid">',
    ...Array.from(
      { length: 9 },
      (_, i) =>
        `  <button class="cell" data-cell="${i}" type="button" aria-label="Cell ${i + 1}"></button>`,
    ),
    '</div>',
  ].join('\n');

  return [
    '',
    'The DOM failure is actionable: the page has an empty grid container, but the script reads `document.querySelectorAll(".cell")`, so it finds zero cells.',
    `Patch the board markup first: \`${formatReplaceInFileCall(filePath, emptyGridMatch[0], replacement)}\`. Then make sure the click listener uses those \`.cell\` elements. Do not append another unrelated script fragment.`,
  ].join('\n');
}

function formatReplaceInFileCall(filePath: string, find: string, replace: string): string {
  return `replace_in_file({ path: ${JSON.stringify(filePath)}, find: ${JSON.stringify(find)}, replace: ${JSON.stringify(replace)}, occurrence: "first" })`;
}

function formatPageErrorRepairHint(
  filePath: string,
  report: RuntimeReport,
  fileContent: string | undefined,
): string {
  const firstUndefined = firstUndefinedIdentifier(report.pageErrors);
  if (!firstUndefined) return '';

  const variant = fileContent ? findCaseVariant(fileContent, firstUndefined) : null;
  if (variant) {
    return [
      '',
      `The page error is actionable: \`${firstUndefined}\` is undefined, and this file already contains the casing variant \`${variant}\`.`,
      `Patch the identifier itself, not a nearby DOM line: \`replace_in_file({ path: "${filePath}", find: "${firstUndefined}", replace: "${variant}", occurrence: "all" })\`. Do not make an identity edit.`,
    ].join('\n');
  }

  const likely = fileContent ? findLikelyIdentifierVariant(fileContent, firstUndefined) : null;
  if (likely) {
    return [
      '',
      `The page error is actionable: \`${firstUndefined}\` is undefined, and this file already contains the likely intended identifier \`${likely}\`.`,
      `Patch the typo directly: \`replace_in_file({ path: "${filePath}", find: "${firstUndefined}", replace: "${likely}", occurrence: "all" })\`. Do not make an identity edit.`,
    ].join('\n');
  }

  return [
    '',
    `The page error is actionable: \`${firstUndefined}\` is undefined. Search the file for that exact identifier and the variable/function it was meant to reference, then patch the bad identifier directly with \`replace_in_file\`. Do not patch a nearby unrelated line.`,
  ].join('\n');
}

function firstUndefinedIdentifier(errors: readonly string[]): string | null {
  for (const error of errors) {
    const match = error.match(/\b([A-Za-z_$][\w$]*) is not defined\b/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function findCaseVariant(fileContent: string, identifier: string): string | null {
  const variants = new Set<string>();
  const re = new RegExp(`\\b${escapeRegExp(identifier)}\\b`, 'gi');
  for (const match of fileContent.matchAll(re)) {
    const value = match[0];
    if (value !== identifier) variants.add(value);
  }
  return variants.size === 1 ? [...variants][0]! : null;
}

function findLikelyIdentifierVariant(fileContent: string, identifier: string): string | null {
  if (identifier.length < 4) return null;
  const identifiers = new Set<string>();
  for (const match of fileContent.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
    const value = match[0];
    if (value !== identifier && Math.abs(value.length - identifier.length) <= 2) {
      identifiers.add(value);
    }
  }

  let best: { value: string; distance: number } | null = null;
  let tied = false;
  for (const value of identifiers) {
    const distance = editDistance(identifier, value);
    if (distance > 2) continue;
    if (!best || distance < best.distance) {
      best = { value, distance };
      tied = false;
    } else if (distance === best.distance && value !== best.value) {
      tied = true;
    }
  }
  return best && !tied ? best.value : null;
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] =
        a[i - 1] === b[j - 1] ? prev[j - 1]! : Math.min(prev[j - 1]!, prev[j]!, curr[j - 1]!) + 1;
    }
    for (let j = 0; j < curr.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface TargetGezel {
  gezelId: string;
  sessionId: string;
  projectId?: string;
}

/**
 * Resolve which gezel to nudge. When the project is known, prefer the
 * workspace journal's last writer for the failing file; in multi-role flows
 * the most recently active session may be an image specialist or reviewer who
 * cannot repair the authored HTML/source. Fall back to the most recently
 * active non-meester session when ownership is unavailable.
 */
async function pickTargetGezel(
  ctx: EvalContext,
  filePath: string,
  projectId?: string,
): Promise<TargetGezel | null> {
  const { sessions } = await ctx.client.listChatSessions();
  const candidates = sessions
    .filter((s) => s.gezelId !== ctx.meesterId && !s.archived)
    .sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  if (projectId) {
    try {
      const { entries } = await ctx.client.listWorkspaceWrites(projectId, 100);
      const normalizedFilePath = normalizeJournalPath(filePath);
      const owner = entries.find(
        (entry) =>
          entry.op === 'write' &&
          normalizeJournalPath(entry.path) === normalizedFilePath &&
          (entry.sessionId || entry.gezelId),
      );
      const ownedSession = owner
        ? candidates.find(
            (session) =>
              (owner.sessionId && session.id === owner.sessionId) ||
              (!owner.sessionId && owner.gezelId && session.gezelId === owner.gezelId),
          )
        : undefined;
      if (ownedSession) {
        return {
          gezelId: ownedSession.gezelId,
          sessionId: ownedSession.id,
          projectId: ownedSession.projectId ?? projectId,
        };
      }
    } catch {
      // Older daemons / narrow test fakes may not expose the journal route.
      // Recency remains a safe compatibility fallback.
    }
  }
  const top =
    (projectId ? candidates.find((session) => session.projectId === projectId) : undefined) ??
    candidates[0];
  if (!top) return null;
  return {
    gezelId: top.gezelId,
    sessionId: top.id,
    projectId: top.projectId,
  };
}

function normalizeJournalPath(path: string): string {
  return path
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/^workspace\//, '');
}

/**
 * Test-only escape hatch: clear the dedup memory for a context. The
 * production code path never needs this — each trial gets a fresh
 * EvalContext, and WeakMap-keyed state dies with it — but unit tests
 * that reuse a single ctx across cases want a reset.
 */
export function _resetNudgeMemoryForTests(ctx: EvalContext): void {
  nudgeMemory.delete(ctx);
}
