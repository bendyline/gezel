import { resolveRelative } from '@bendyline/gezel/checks';
import {
  MIN_INLINE_JS_BYTES,
  detectUnclosedScript,
  extractInlineScripts,
  validateScriptSyntax,
} from './html-validation.ts';

// Distinct-match counting + ordered-section checks now live in the shared
// checks module (the same code the gate stdlib's checkDistinctMatches /
// checkOrderedSections run) — re-exported so scenario code keeps its
// existing imports.
export { countDistinctMatches, requireOrderedSections } from '@bendyline/gezel/checks';

// Deliberately STRICTER than the shared checks module's IMG_EXT (which
// accepts .svg): the petshop brief requires a GENERATED raster logo, and
// a hand-written inline SVG must not satisfy it. Scenario judgment stays
// eval-only; the generic gate (checkImageRefsResolve) keeps svg.
const RASTER_IMG_EXT = /\.(png|jpe?g|webp|gif)$/i;

export interface SniffResult {
  ok: boolean;
  /** Heuristics that fired — exposed so the trial log can record which signals passed. */
  signals: string[];
  /** Score (0-N) from the heuristics; ok depends on per-sniff rules, not just count. */
  score: number;
  /**
   * Maximum semantic-signal score for this sniff. When present the trial
   * log emits `score=N/M`, which lets the fixed postmortem rubric grade a
   * partial artifact proportionally instead of falling back to the
   * denominator-less 5/2.5 quality buckets.
   */
  scoreMax?: number;
  /**
   * Why the sniff didn't pass when `ok === false` — present when a
   * REQUIRED signal failed (e.g. JS parse error, JS too small). The
   * trial log surfaces this so it's obvious from the failure summary
   * whether the model produced "looks-like-a-game but JS is broken"
   * vs "looks-nothing-like-a-game."
   */
  failReason?: string;
  /**
   * Signal names the sniff checked for but that didn't fire. Populated
   * when `ok === false`. Consumed by the sniff-feedback nudge module
   * to tell the model which specific checks it's missing (e.g. petshop
   * stalled at 4 signals because `working-image` never fired
   * — the `<img>` referenced a path that didn't exist — and the model
   * had no signal naming `working-image` as the missing piece).
   *
   * Order is the sniff's natural checking order — preserves the "what
   * the scenario cares about most" ranking.
   */
  missingRequiredSignals?: string[];
}

const MIN_GAME_HTML_BYTES = 4096;

function ticTacToeEnhancementCount(lower: string): number {
  let count = 0;
  const hasTurnStatus =
    /(?:status|message)[a-z0-9_-]*(?:el|element)?/.test(lower) &&
    /(?:currentplayer|current_player|turn)/.test(lower) &&
    /(?:textcontent|innertext|innerhtml)\s*=/.test(lower);
  if (hasTurnStatus) count += 1;

  const hasReset =
    /(?:reset|restart|play again|new game)/.test(lower) &&
    /addeventlistener\s*\(\s*['"]click['"]/.test(lower) &&
    /array\s*\(\s*9\s*\)\s*\.fill\s*\(\s*['"]?['"]?\s*\)/.test(lower);
  if (hasReset) count += 1;

  const hasWinningHighlight =
    /(?:winner|winning|win-line|winning-line)/.test(lower) &&
    /classlist\s*\.\s*add\s*\(/.test(lower);
  if (hasWinningHighlight) count += 1;

  const hasDrawDetector =
    /(?:draw|tie|cat['"]?s game)/.test(lower) &&
    /(?:every\s*\(|includes\s*\(\s*['"]['"]\s*\)|filter\s*\()/.test(lower);
  if (hasDrawDetector) count += 1;

  const hasScoreTracking =
    /(?:scoreboard|scorex|scoreo|xscore|oscore|score\s*[+=])/.test(lower) &&
    /(?:\+\+|\+=\s*1|setitem|textcontent\s*=)/.test(lower);
  if (hasScoreTracking) count += 1;

  return count;
}

/**
 * Shared static-content invariants for the interactive-game scenarios.
 * Returns the two JS-quality signals plus a `failReason` hook the
 * caller can pass through to the user-facing failure log.
 *
 * Both signals are REQUIRED for `ok` in the game scenarios — they
 * close the "skeleton HTML that mentions the right words" loophole.
 * Wild-caught (qwen3.6 tank-combat trial): a 1.5 KB HTML
 * whose `<script>` ended `let|` mid-declaration was passing the old
 * sniff because all the keyword/grid/handler signals were present.
 */
export function jsQualitySignals(
  html: string,
  /**
   * Per-model override for the inline-JS minimum-size floor. When
   * unset, the shared `MIN_INLINE_JS_BYTES` constant applies. Loaded
   * from `ChatModelManifestSchema.evalHints.sniffThresholds.inlineJsMinBytes`
   * by the eval runner and threaded through here via the scenario
   * sniff. Wild-caught (nemotron-super tictactoe): the
   * model writes idiomatic 1996-byte tic-tac-toe games, 52 bytes
   * under the 2048-byte default; a per-model 1500-byte floor accepts
   * the model's natural style.
   */
  opts?: { minInlineJsBytes?: number },
): {
  signals: string[];
  failReason?: string;
  /**
   * Set when the script parses cleanly but doesn't meet the minimum size
   * — the "compact-template-loop" case the scenario sniffs use to swap
   * the bytes-count failReason with a feature-list one. Wild-caught
   * (nemotron-super tictactoe): the model wrote 1996 bytes of
   * working JS on every iteration, 52 bytes under the 2048-byte
   * threshold; a numeric "you need 52 more bytes" reason produced the
   * same 1996-byte rewrite every time. Feature-list reason names the
   * specific missing pieces (Reset button, status banner, win-line
   * highlight) so the model has a concrete next action.
   */
  jsTooSmall?: boolean;
  /** Inline JS size when `jsTooSmall` is set. */
  jsBytes?: number;
} {
  const minBytes = opts?.minInlineJsBytes ?? MIN_INLINE_JS_BYTES;
  // Step 1: unclosed-script detection runs BEFORE the strict-regex
  // extractor because the extractor needs a closing tag to anchor
  // on. A page that emits `<script>\nlet game = …` and truncates
  // there has real bytes the regex can't see — we'd report "js=0
  // bytes" which is misleading. The unclosed-script check tells the
  // truth: the model started a script and the stream cut off.
  const closure = detectUnclosedScript(html);
  if (closure.unclosed) {
    return {
      signals: [],
      failReason: `inline <script> opened ${closure.opens}× but only closed ${closure.closes}× — the write_file body was truncated mid-script (no </script> ever arrived). Use \`append_to_file\` to finish the script in a follow-up call, or re-emit a leaner version of the whole page.`,
    };
  }
  const scripts = extractInlineScripts(html);
  const v = validateScriptSyntax(scripts);
  const signals: string[] = [];
  if (v.allParse) signals.push('js-parses');
  if (v.totalBytes >= minBytes) signals.push('js-size-ok');
  if (!v.allParse) {
    // 240 chars so the TypeScript-only-syntax diagnosis (appended by
    // validateScriptSyntax) survives — at 120 the actionable half of the
    // message was exactly the part that got cut.
    const head = v.firstError ? v.firstError.slice(0, 240) : 'unknown parse error';
    return { signals, failReason: `inline JS does not parse (${head})` };
  }
  if (v.totalBytes < minBytes) {
    // Distinguish "no <script> tag at all" from "tag present but
    // body too small" — the former is a different failure mode (the
    // model wrote pure HTML/CSS, e.g. e4b tankcombat
    // produced a 17 KB animated-CSS page with zero script tags) and
    // reads as a misleading message otherwise. `extractInlineScripts`
    // returns [] for both `<script src="...">` (no inline body) and
    // for a doc with no script tag, so this branch covers both.
    if (scripts.length === 0) {
      return {
        signals,
        failReason: `no inline <script> tag found in the HTML; an interactive game needs JavaScript (the page may be CSS-only animation or use an external src= you can't ship in a single file)`,
      };
    }
    return {
      signals,
      failReason: `inline JS is only ${v.totalBytes} bytes (< ${minBytes}); a real interactive game needs more state + handler + loop code than that`,
      jsTooSmall: true,
      jsBytes: v.totalBytes,
    };
  }
  return { signals };
}

/**
 * Heuristic content sniff for "is this HTML actually a tic-tac-toe game?"
 * Four independent signals; ok if at least 3 fire.
 *
 * The threshold is forgiving for layout variation but resistant to "empty
 * stub" false positives — a blank `<html><body>tic-tac-toe</body></html>`
 * fires only signal (a) and rightly fails.
 */
export function ticTacToeContentSniff(
  html: string,
  opts?: { minInlineJsBytes?: number },
): SniffResult {
  const lower = html.toLowerCase().replace(/[\u2010-\u2015\u2212]/g, '-');
  const signals: string[] = [];

  // (a) The literal name appears.
  if (/tic[-\s]?tac[-\s]?toe/.test(lower)) signals.push('name');

  // (b) Some 3x3 grid signal — either a CSS grid template, 9+ literal
  // cells, or JS that dynamically creates a 9-cell board. Runtime
  // assertions already accept `<td>` cells; this static sniff should not
  // reject the same valid table board just because the cells are appended
  // from script.
  const gridCss = /grid-template-columns\s*:\s*repeat\s*\(\s*3/.test(lower);
  const cellCount =
    (lower.match(/<button\b/g)?.length ?? 0) +
    (lower.match(/<td\b/g)?.length ?? 0) +
    (lower.match(/class\s*=\s*["'][^"']*\bcell\b/g)?.length ?? 0);
  const dynamicNineCellBoard =
    /\barray\s*\(\s*9\s*\)/.test(lower) &&
    /createelement\s*\(\s*['"](?:td|button|div)['"]\s*\)/.test(lower) &&
    /(for\s*\([^)]*<\s*9|\.foreach\s*\()/.test(lower);
  if (gridCss || cellCount >= 9 || dynamicNineCellBoard) signals.push('grid');

  // (c) JS click-handling — explicit listener or inline handler.
  if (/addeventlistener\s*\(\s*['"]click['"]/.test(lower) || /onclick\s*=/.test(lower)) {
    signals.push('click');
  }

  // (d) Win-detection logic — either an explicit array of winning lines or
  // repeated cell-comparison patterns.
  const winLines = /\[\s*\[?\s*0\s*,\s*1\s*,\s*2/.test(lower);
  const winCheck = /(===|==).+(===|==).+/.test(lower) && /winner|winning|won|iswin/.test(lower);
  if (winLines || winCheck) signals.push('win-detect');

  // (e) + (f): JS actually parses and is large enough to plausibly
  // implement the game. Both REQUIRED — a tic-tac-toe page whose JS
  // doesn't run isn't a tic-tac-toe game.
  const jq = jsQualitySignals(html, opts);
  signals.push(...jq.signals);
  if (
    jq.jsTooSmall === true &&
    !signals.includes('js-size-ok') &&
    ticTacToeEnhancementCount(lower) >= 2
  ) {
    signals.push('js-size-ok');
  }

  // Pass requires: ≥3 of the 4 keyword/structure signals, AND both
  // JS-quality signals (parses + ≥4KB). The 4-keyword threshold is
  // unchanged from before; the JS signals are additive.
  const keywordHits =
    (signals.includes('name') ? 1 : 0) +
    (signals.includes('grid') ? 1 : 0) +
    (signals.includes('click') ? 1 : 0) +
    (signals.includes('win-detect') ? 1 : 0);
  const jsOk = signals.includes('js-parses') && signals.includes('js-size-ok');
  const ok = keywordHits >= 3 && jsOk;
  const TICTACTOE_CANDIDATES = ['name', 'grid', 'click', 'win-detect', 'js-parses', 'js-size-ok'];
  const missingRequiredSignals = ok
    ? undefined
    : TICTACTOE_CANDIDATES.filter((s) => !signals.includes(s));
  // When the only failure is "JS just under the size threshold" AND the
  // page is otherwise functional (game keyword signals fire, JS parses),
  // swap the numeric "you need N more bytes" reason for a concrete
  // feature list. Numeric reasons produce the same rewrite every time;
  // feature lists give the model a real next move. See `jsTooSmall`
  // docstring in `jsQualitySignals`.
  const onlyJsSizeMissing =
    !ok &&
    jq.jsTooSmall === true &&
    missingRequiredSignals?.length === 1 &&
    missingRequiredSignals[0] === 'js-size-ok';
  const featureListReason = onlyJsSizeMissing
    ? `Your tic-tac-toe is functional but minimal (inline JS is ${jq.jsBytes} bytes). Add at least 2 of these features to flesh it out: (1) a status banner that names whose turn it is ("X's turn" / "O's turn"); (2) a Reset / Play Again button wired to clear the board and reset turn state; (3) winning-line highlight (CSS class on the 3 cells that form the win); (4) a tie/draw detector with its own end-state message; (5) score tracking across rounds. Each adds substantive code naturally — do NOT pad with comments.`
    : undefined;
  const chosenReason = featureListReason ?? (!ok ? jq.failReason : undefined);
  return {
    ok,
    signals,
    score: signals.length,
    ...(chosenReason ? { failReason: chosenReason } : {}),
    ...(missingRequiredSignals && missingRequiredSignals.length > 0
      ? { missingRequiredSignals }
      : {}),
  };
}

export interface PetShopSniffOpts {
  /**
   * Path of the HTML file we're sniffing, relative to the **project root**
   * (e.g. `workspace/index.html` or `workspace/public/index.html`). Required
   * so we can resolve relative `<img src>` paths against the project tree.
   */
  htmlPath: string;
  /**
   * Every file in the project, as paths relative to the project root —
   * across BOTH workspace/ and artifacts/. Used to verify that an
   * `<img src>` reference points at a real file. Without this we can't
   * tell a working logo from a broken `<img src="logo.png">` link.
   */
  projectFiles: string[];
  /** Project-rooted raster paths whose bytes have a real image signature
   * and a non-trivial payload. An extension-only placeholder must not
   * satisfy the generated-logo gate. */
  validRasterFiles: string[];
}

/**
 * Heuristic sniff for "is this HTML actually a pet shop website with a
 * functioning custom logo?" Five signals; pet-vocab AND working-image
 * are both REQUIRED.
 *
 * The strictness is deliberate: most failure modes for this scenario are
 * "the model wrote `<img src='logo.png'>` but never generated the file"
 * — or, more subtly, generated the file but in the wrong directory so
 * the `<img>` link is broken. Counting either of those as a pass
 * inflates the success-rate signal in ways that hide real model
 * shortcomings.
 */
/** The REQUIRED pet-shop subject gate — shared with `grader-lint.test.ts`
 * so the gate and the prompt-satisfiability lint can't drift apart. */
export const PET_SUBJECT_PATTERN =
  /\b(pet|paws?|puppy|puppies|kitten|kittens|dog|cat|bird|fish|rabbit|reptile|hamster)s?\b/;

export function petShopContentSniff(html: string, opts: PetShopSniffOpts): SniffResult {
  const lower = html.toLowerCase();
  const signals: string[] = [];
  const closure = detectUnclosedScript(html);
  const scriptValidation = validateScriptSyntax(extractInlineScripts(html));
  const scriptFailReason = closure.unclosed
    ? `inline <script> opened ${closure.opens}× but only closed ${closure.closes}× — the page is truncated and cannot run`
    : !scriptValidation.allParse
      ? `inline JS does not parse (${scriptValidation.firstError ?? 'unknown parse error'})`
      : undefined;

  // (a) Subject-matter — pet-related vocabulary appears in the body.
  if (PET_SUBJECT_PATTERN.test(lower)) {
    signals.push('pet-vocab');
  }

  // (b) Commercial framing — store/shop/adopt/buy. Distinguishes a pet
  // shop from a generic pet wiki page.
  if (/\b(shop|store|adopt|buy|cart|checkout|product|catalog|catalogue|browse)\b/.test(lower)) {
    signals.push('store-vocab');
  }

  // (c) Multi-section structure — pet shops typically have a header, a
  // products/services area, and contact/about. We check for at least
  // 2 distinct semantic-section signals.
  const sectionTokens = [
    /<header\b/,
    /<nav\b/,
    /<section\b/,
    /<main\b/,
    /<footer\b/,
    /\bclass\s*=\s*["'][^"']*\b(hero|banner|features|products|services|about|contact)\b/,
  ];
  const sectionHits = sectionTokens.filter((re) => re.test(lower)).length;
  if (sectionHits >= 2) signals.push('structured-page');

  // (d) **Working image link** — at least one `<img src="X">` (or
  // `<img src='X'>`) where X resolves to a real file in the project
  // tree relative to the HTML's directory. This is the strict version
  // of "the page actually shows an image" — broken refs and refs to
  // nonexistent files don't count.
  const imgRefs: string[] = [];
  const imgRe = /<img\b[^>]*\bsrc\s*=\s*("([^"]+)"|'([^']+)')/gi;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration
  while ((m = imgRe.exec(html)) !== null) {
    const src = m[2] ?? m[3];
    if (src) imgRefs.push(src);
  }
  const fileSet = new Set(opts.projectFiles.map((p) => p.replace(/\\/g, '/')));
  const validRasterSet = new Set(opts.validRasterFiles.map((p) => p.replace(/\\/g, '/')));
  const workingLink = imgRefs.some((src) => {
    if (!RASTER_IMG_EXT.test(src.replace(/[?#].*$/, ''))) return false;
    const resolved = resolveRelative(opts.htmlPath, src);
    return resolved !== null && fileSet.has(resolved) && validRasterSet.has(resolved);
  });
  if (workingLink) signals.push('working-image');

  // (e) Bonus: any image asset exists in the project at all. Distinct
  // from working-image — present even when the dev generated a logo
  // but linked it from the wrong path. Useful diagnostic in the log
  // even though it doesn't change pass/fail.
  if (opts.validRasterFiles.length > 0) signals.push('image-asset');

  // pet-vocab AND working-image are both REQUIRED. A page without
  // pet-vocab isn't about pet shops; a page without a working image
  // link is broken even if assets exist somewhere on disk.
  const ok =
    !scriptFailReason &&
    signals.includes('pet-vocab') &&
    signals.includes('working-image') &&
    signals.length >= 4;
  const PETSHOP_CANDIDATES = [
    'pet-vocab',
    'store-vocab',
    'structured-page',
    'working-image',
    'image-asset',
  ];
  const missingRequiredSignals = ok
    ? undefined
    : PETSHOP_CANDIDATES.filter((s) => !signals.includes(s));

  return {
    ok,
    signals,
    score: signals.length,
    scoreMax: PETSHOP_CANDIDATES.length,
    ...(scriptFailReason ? { failReason: scriptFailReason } : {}),
    ...(missingRequiredSignals && missingRequiredSignals.length > 0
      ? { missingRequiredSignals }
      : {}),
  };
}

/**
 * The REQUIRED subject gate of a game-content sniff. Every grader that
 * hard-requires a subject vocabulary MUST pair it with a scenario whose
 * prompt actually asks for that subject — `requiredPromptEvidence` on
 * the scenario + `grader-lint.test.ts` enforce this. Wild-caught
 * Arcade-deluxe reused the tank sniff verbatim, so `tank-vocab`
 * was REQUIRED for a prompt that never says "tank" — an unwinnable
 * grader that burned a 120B model through 8 futile polish rewrites.
 */
export interface SubjectVocab {
  /** Signal name emitted when the pattern matches (e.g. 'tank-vocab'). */
  signal: string;
  /** Tested against the lowercased HTML. */
  pattern: RegExp;
  /** Short label used in feedback prose (e.g. 'tank-combat'). */
  label: string;
}

export const TANK_SUBJECT_VOCAB: SubjectVocab = {
  signal: 'tank-vocab',
  pattern: /\btank\w*\b/,
  label: 'tank-combat',
};

/** Generic arcade-game subject gate: any real arcade game (and the
 * arcade-deluxe prompt itself) says "game"/"score"/"player". */
export const ARCADE_SUBJECT_VOCAB: SubjectVocab = {
  signal: 'arcade-vocab',
  pattern: /\b(game|arcade|score|player)\b/,
  label: 'arcade',
};

/**
 * Heuristic content sniff for "is this HTML actually a top-down arcade
 * game about `subjectVocab`?" (default: tank combat). Six independent
 * signals; ok requires at least 4 (similar threshold to tic-tac-toe but
 * with one more available signal because arcade games have richer
 * required mechanics).
 *
 * The signals are layered to resist false positives:
 *   - the subject vocab is REQUIRED — without it, the page isn't about
 *     the requested subject at all.
 *   - canvas / 2D rendering is the dominant approach for a top-down
 *     arcade game; either an HTML canvas or SVG-based rendering counts.
 *   - keyboard input — a playable game listens for arrow keys / WASD.
 *   - shooting/projectile mechanics — central to "combat".
 *   - game loop (requestAnimationFrame, setInterval-based tick) — the
 *     thing that distinguishes a playable game from a static page with
 *     a tank illustration.
 *   - collision / hit / damage / score — gameplay signal beyond pure
 *     movement.
 */
export function tankCombatContentSniff(
  html: string,
  opts?: { minInlineJsBytes?: number; minHtmlBytes?: number; subjectVocab?: SubjectVocab },
): SniffResult {
  const vocab = opts?.subjectVocab ?? TANK_SUBJECT_VOCAB;
  const lower = html.toLowerCase();
  const signals: string[] = [];

  // (a) The literal subject — required.
  if (vocab.pattern.test(lower)) signals.push(vocab.signal);

  // (b) Canvas / SVG rendering surface.
  if (/<canvas\b/.test(lower) || /<svg\b/.test(lower)) signals.push('render-surface');

  // (c) Keyboard input — arrow keys, WASD, or generic keydown listener.
  if (
    /addeventlistener\s*\(\s*['"]key(down|up|press)['"]/.test(lower) ||
    /onkey(down|up|press)\s*=/.test(lower) ||
    /\b(arrowup|arrowdown|arrowleft|arrowright|key[wasd])\b/.test(lower)
  ) {
    signals.push('keyboard-input');
  }

  // (d) Shooting / projectile mechanics — central to "combat". Match
  // common variable / function names that almost any tank-game source
  // will carry.
  if (
    /\b(bullet|projectile|missile|shoot|fire(?:ing|s)?|shell)s?\b/.test(lower) ||
    /\bshoot\s*\(/.test(lower)
  ) {
    signals.push('combat');
  }

  // (e) Game loop — `requestAnimationFrame` is the modern shape; older
  // shapes are `setInterval(..., 1000/60)` or named `tick` / `update`
  // / `loop` functions called recursively.
  if (
    /requestanimationframe\s*\(/.test(lower) ||
    /setinterval\s*\(/.test(lower) ||
    /\bfunction\s+(tick|update|loop|gameloop|gametick)\b/.test(lower)
  ) {
    signals.push('game-loop');
  }

  // (f) Collision / hit / damage / score — gameplay beyond mere
  // movement. We accept either explicit collision keywords or simple
  // hit/score variables.
  if (
    /\b(collide|collision|intersects|overlap|hitbox)\b/.test(lower) ||
    /\b(score|hp|health|lives|damage|hit)s?\b/.test(lower)
  ) {
    signals.push('gameplay');
  }

  // (g) + (h): JS parses + meets minimum size. Both REQUIRED — a
  // tank-combat HTML whose `<script>` ends `let|` mid-declaration
  // (wild-caught qwen3.6 trial) is not a working game even
  // if every keyword signal lights up.
  const jq = jsQualitySignals(html, opts);
  signals.push(...jq.signals);
  if (html.length >= (opts?.minHtmlBytes ?? MIN_GAME_HTML_BYTES)) signals.push('html-size-ok');

  // The subject vocab is REQUIRED. Beyond that, require 4 of 6 keyword
  // signals (unchanged), both JS-quality signals so a truncated
  // skeleton can't pass, AND the rubric's 4 KB game-file quality floor
  // so "works but barely" does not terminate before the model can add
  // meaningful play/polish.
  const keywordHits =
    (signals.includes(vocab.signal) ? 1 : 0) +
    (signals.includes('render-surface') ? 1 : 0) +
    (signals.includes('keyboard-input') ? 1 : 0) +
    (signals.includes('combat') ? 1 : 0) +
    (signals.includes('game-loop') ? 1 : 0) +
    (signals.includes('gameplay') ? 1 : 0);
  const jsOk = signals.includes('js-parses') && signals.includes('js-size-ok');
  const htmlSizeOk = signals.includes('html-size-ok');
  const ok = signals.includes(vocab.signal) && keywordHits >= 4 && jsOk && htmlSizeOk;
  const TANKCOMBAT_CANDIDATES = [
    vocab.signal,
    'render-surface',
    'keyboard-input',
    'combat',
    'game-loop',
    'gameplay',
    'js-parses',
    'js-size-ok',
    'html-size-ok',
  ];
  const missingRequiredSignals = ok
    ? undefined
    : TANKCOMBAT_CANDIDATES.filter((s) => !signals.includes(s));
  // Same compact-template substitution as tictactoe: when the game is
  // otherwise functional but too small, name concrete arcade features
  // the model can add. This now covers both JS-size and total
  // file-size misses so the pass condition matches the scoring rubric.
  const compactButFunctional =
    !ok &&
    missingRequiredSignals !== undefined &&
    missingRequiredSignals.every(
      (signal) => signal === 'js-size-ok' || signal === 'html-size-ok',
    ) &&
    signals.includes(vocab.signal) &&
    keywordHits >= 4 &&
    signals.includes('js-parses');
  const featureListReason = compactButFunctional
    ? `Your ${vocab.label} game is functional but minimal (HTML is ${html.length} bytes; inline JS is ${jq.jsBytes ?? 'large enough'} bytes). Add at least 2 of these features: (1) collision detection between projectiles and enemies/player, plus a hit/health/death state; (2) enemy AI that pursues / dodges / fires back rather than standing still; (3) particle/explosion effects on hit (canvas circles fading over time count); (4) HUD with score and remaining lives or ammo; (5) game-over screen with a Restart button. Each adds substantive code naturally — do NOT pad with comments.`
    : undefined;
  const chosenReason = featureListReason ?? (!ok ? jq.failReason : undefined);
  return {
    ok,
    signals,
    score: signals.length,
    ...(chosenReason ? { failReason: chosenReason } : {}),
    ...(missingRequiredSignals && missingRequiredSignals.length > 0
      ? { missingRequiredSignals }
      : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Generic text-sniff helpers — used by the new schema-migration,
// bookstore-openapi, and incident-postmortem scenarios that produce
// non-HTML deliverables (TS, YAML, Markdown). Kept here so future
// scenarios reusing these patterns don't re-implement them.
