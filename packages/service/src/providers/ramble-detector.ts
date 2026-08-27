/**
 * "Stuck planning" detector for verbose-family local models.
 *
 * The original implementation disarmed permanently the first time a
 * `<tool_call>` substring appeared in the content stream. That was a
 * one-shot signal — it didn't catch the actual failure mode in the
 * wild, where Qwen 3.6 27B (and similar) emit a tool-call markup
 * block early, then continue narrating for thousands of characters
 * about what they "would" do next, never closing with another action.
 * The first markup permanently silenced the watchdog and the model
 * burned through the rest of its budget without making progress.
 *
 * This helper measures **prose-since-last-action**: every time the
 * model emits a tool-call signal (markup substring OR structured
 * delta), the counter resets to the current content length. The
 * abort fires when the next prose run exceeds the threshold from
 * that anchor — catching the "wrote one tool then rambled" pattern
 * the boolean version missed.
 *
 * Gated on verbose-family models because frontier non-verbose models
 * can produce legitimate medium-length prose responses that would
 * trip the threshold.
 *
 * Reasoning-format awareness: verbose-family models leak their
 * chain-of-thought as visible text — Gemma 4 / gpt-oss wrap it in
 * `<|channel>` tags, Qwen 3.5/3.6 and DeepSeek-R1 distillates in
 * `<think>…</think>`. Both must count as "the model is doing work,"
 * not ramble. Channel tags reset the cold counter inline; `<think>`
 * spans are tracked open-to-close and granted the loose inside-call
 * budget (the reasoning runs to completion, then the close anchors
 * the prose counter so the visible answer is measured fresh). The
 * `<think>`-stripping that moves this text into `ChatMessage.reasoning`
 * happens AFTER the stream closes, so without this the leaked
 * chain-of-thought counts in full against the ~6 KB cold cap and the
 * turn aborts mid-thought before the tool call lands.
 */
export interface RambleDetectorOpts {
  /**
   * "Cold ramble" cap — applies before any tool-call signal has been
   * seen this iteration. ~6000 chars (~1500 tokens) at MLX's typical
   * tok/s is ~90s of "model is talking but never engaged tools."
   * Tight enough to feel responsive; loose enough that a legitimate
   * medium-length pure-prose explanation passes through.
   */
  threshold: number;
  /**
   * "Post-action ramble" cap — applies once any tool-call signal has
   * appeared (markup substring or structured delta). The cookbook
   * pattern this catches: model writes a tool call, then starts
   * narrating "Setting up… Writing… Now I'm…" without writing the
   * next file. Once the model has shown it CAN call a tool, prose
   * after that is planning paralysis — fire the queued tools sooner
   * so the model gets feedback. Defaults to ~25% of `threshold` so
   * the post-action cap is meaningfully tighter than the cold cap.
   *
   * The tighter cap pairs with the graceful-ramble-fallthrough in
   * each provider: when this fires AND the buffer has salvageable
   * markup, the salvage path runs and the model sees real tool
   * results on the next iteration — closing the in-iteration
   * feedback loop that was missing.
   */
  postActionThreshold?: number;
  /**
   * Threshold applied while the model is INSIDE an unclosed
   * `<function=...>` / `<tool_call>` span (i.e. writing a long tool
   * parameter body). Defaults to `max(32_000, 5 × threshold)`.
   * Wild-caught (qwen3.6 tankcombat matrix): without a
   * dedicated inside-call threshold, the cold `threshold` (~6 KB)
   * truncated tankcombat scripts mid-write because the file's HTML
   * + JS exceeded that budget. Bumping this is the right knob — the
   * supervisor's turn-deadline remains the runaway guardrail.
   */
  insideCallThreshold?: number;
  /**
   * Master gate for the LENGTH caps (cold / post-action / inside-call).
   * When false, those caps become a no-op — used to disable on
   * non-verbose families where a long, legitimate prose answer would
   * otherwise trip the ~6 KB cold cap.
   */
  enabled: boolean;
  /**
   * Independent gate for the repetition guard (trigram-novelty loop
   * detection). Unlike the length caps, the guard fires ONLY on
   * genuinely degenerate repetition — the same phrases re-emitted below
   * {@link repetitionMinNovelty} over a full window — which no
   * legitimate answer produces. That makes it safe to arm even where the
   * length caps are off, so it is gated separately from {@link enabled}.
   *
   * Defaults to {@link enabled} (verbose-family models already ran both).
   * Set true on a non-verbose model to catch a repetition loop without
   * the length caps — wild-caught (ds4 `deepseek-v4-flash-284b-q2`,
   * voorman "Ikari Warriors"): a q2 quant at ~60 KB context opened a
   * DeepSeek tool-call block, fell into prose, and re-emitted the same
   * diagnosis past 4000 tokens with no close and no guard, because the
   * whole detector was a no-op for a non-verbose (length-cap-off) family.
   */
  repetitionGuardEnabled?: boolean;
  /**
   * The model leaks its chain-of-thought as UNTAGGED visible prose
   * (not wrapped in `<think>` / `<|channel>`). For these models the
   * pre-tool "cold" prose IS reasoning — they narrate the plan in the
   * open, then act. A flat 6 KB cold cap guillotines them mid-plan,
   * right as they reach the tool call (wild-caught: a voorman
   * leaked ~6000 chars of "I need to… I will: 1. ensure_gezel a" and
   * aborted one token before the call). When set, the COLD cap (only)
   * is multiplied by {@link LEAKY_REASONING_COLD_MULTIPLIER} so untagged
   * planning gets room to reach an action — the post-action and
   * inside-call caps are unchanged, so a model that DID act still can't
   * ramble, and a truly-stuck leaker still aborts (just later).
   */
  leakyReasoning?: boolean;
  /**
   * The chat template emits the opening `<think>` itself, so generation
   * starts INSIDE a reasoning span and the open marker never appears in
   * the content stream. Without this the span-tracking below never arms
   * — `insideReasoning` stays false for the whole chain-of-thought and
   * the model's thinking is scored against the cold cap.
   *
   * Wild-caught (qwen3.8-27b-q4 MLX, PR-review batch step): the engine
   * armed a 4096-token think budget (`opens_in_think=True`) while the
   * detector guillotined at 12003 chars — the two budgets disagreed, so
   * the turn died mid-thought, ~2 KB before the model would have closed
   * `</think>` and emitted its `write_artifact` call. Reproduced on two
   * unrelated tasks within an hour.
   *
   * Equivalent to having observed a `<think>` at offset 0: the span gets
   * the loose {@link RambleDetectorOpts.insideCallThreshold} budget, and
   * the model's own `</think>` then anchors the prose counter so the
   * visible answer is measured fresh. Only meaningful on providers that
   * inline chain-of-thought into the content stream (MLX); engines with
   * a dedicated reasoning channel never show the detector this text.
   */
  opensInReasoning?: boolean;
  /**
   * Trailing-prose window (chars) the repetition guard measures novelty
   * over. The guard stays dormant until prose-since-the-last-action
   * reaches this length — below it there isn't enough sample to tell
   * "spinning" from "warming up." Defaults to
   * {@link DEFAULT_REPETITION_WINDOW}.
   */
  repetitionWindow?: number;
  /**
   * Repetition guard sensitivity. The guard fires when the
   * distinct-word-trigram ratio over the trailing window drops BELOW
   * this value — i.e. the model is re-emitting the same phrases instead
   * of producing new content. Set to 0 to disable the guard entirely
   * (length caps still apply). Defaults to
   * {@link DEFAULT_REPETITION_MIN_NOVELTY}.
   *
   * This is the {@link leakyReasoning} companion fix (wild-caught,
   * qwen3.6 a3b voorman "Space Shooter Arcade"): a leaky
   * model with the 2×-cold budget circled the SAME four hypotheses
   * ("did the user see it? is the workspace stale? do they want the
   * file or its content?") for ~12 KB of untagged prose, never
   * converging, then aborted on the length cap. A length cap can't tell
   * a long-but-progressing plan from a loop; trigram novelty can. The
   * guard catches the loop at ~one window (~2.4 KB) instead of letting
   * it run to the full doubled cold cap.
   *
   * Orthogonal to {@link leakyReasoning}: that knob sets HOW MUCH
   * planning prose is tolerated; this knob detects WHEN that prose has
   * stopped making progress. Both apply to every verbose-family model
   * (the detector is already gated to those via {@link enabled}); the
   * guard is exempted inside unclosed tool-call bodies and reasoning
   * spans, where repetition is legitimate (boilerplate HTML/code, a
   * reasoning chain revisiting an idea).
   */
  repetitionMinNovelty?: number;
}

/**
 * Cold-cap multiplier for {@link RambleDetectorOpts.leakyReasoning}
 * models. 2× turns the default 6 KB cold cap into ~12 KB — enough for a
 * model that narrates its plan in the open to reach the tool call,
 * while still bounding a genuinely runaway monologue.
 */
const LEAKY_REASONING_COLD_MULTIPLIER = 2;

/**
 * Default trailing window (chars) for the repetition guard. ~2.4 KB is
 * roughly a window past which a healthy planner has moved on to new
 * content but a looping one has cycled its phrases several times — small
 * enough to catch a spin early (well inside even the un-doubled 6 KB
 * cold cap), large enough to be a representative sample.
 */
const DEFAULT_REPETITION_WINDOW = 2400;

/**
 * Default novelty floor for the repetition guard: fire when fewer than
 * 40% of the word-trigrams in the window are distinct. Healthy prose —
 * even long, structured, list-heavy prose — sits well above this
 * (distinct trigrams dominate); only a model re-emitting the same
 * sentences collapses below it. Tuned conservatively (high precision):
 * a real circling monologue scores ~0.05–0.20, a genuine varied answer
 * ~0.7+.
 */
const DEFAULT_REPETITION_MIN_NOVELTY = 0.4;

/**
 * The repetition guard ignores windows with fewer than this many
 * DISTINCT words. A single token repeated forever (`aaaa…`, `plan plan
 * plan…`) has near-zero novelty but is the degenerate filler used in
 * tests and the rare stuck-token stream — the length caps already bound
 * those. Requiring real lexical variety keeps the guard targeted at the
 * actual failure: many distinct words arranged into a few repeating
 * sentences (planning paralysis), not a stuck character.
 */
const REPETITION_MIN_DISTINCT_WORDS = 8;

export class RambleDetector {
  private readonly threshold: number;
  /**
   * Cold-mode cap (no tool-call signal seen yet). Equals `threshold`
   * for normal models; for leaky-reasoning models it's
   * `threshold × LEAKY_REASONING_COLD_MULTIPLIER` so untagged planning
   * prose has room to reach an action. Kept separate from `threshold`
   * so the post-action and inside-call caps (which derive from
   * `threshold`) are unaffected.
   */
  private readonly coldThreshold: number;
  private readonly postActionThreshold: number;
  /**
   * Threshold applied while `insideUnclosedCall` is true. Defaults
   * to `max(32_000, 5 × threshold)` — generous enough that a real
   * tank-combat HTML (with ~8 KB of inline JS plus markup) fits
   * inside the write_file call without the cap firing. Tighter than
   * unbounded so a TRULY runaway unclosed call still aborts before
   * the turn deadline. Override via `RambleDetectorOpts.insideCallThreshold`
   * for tests.
   */
  private readonly insideCallThreshold: number;
  private readonly enabled: boolean;
  /**
   * Independent gate for the repetition guard. See
   * {@link RambleDetectorOpts.repetitionGuardEnabled}. When true the
   * guard runs even if {@link enabled} (the length caps) is false.
   */
  private readonly repetitionGuardEnabled: boolean;
  /** Trailing-prose window (chars) the repetition guard measures over. */
  private readonly repetitionWindow: number;
  /** Novelty floor; the guard fires below it. 0 disables the guard. */
  private readonly repetitionMinNovelty: number;
  /** Char offset in `turnContent` of the last action signal we saw. */
  private lastActionAtChars = 0;
  /** Char offset up to which we've already scanned for markup. */
  private scannedUpTo = 0;
  /** True once any tool-call signal has been observed this iteration. */
  private hasSeenAction = false;
  /**
   * Char offset of the end of the most recent close marker
   * (`</function>` / `</tool_call>`). -1 until first seen. Used by
   * the post-action gate to distinguish "prose after a closed tool
   * call" (apply tight cap) from "content inside an unclosed call"
   * (apply loose cap so big write_file bodies don't fire prematurely).
   */
  private lastCloseEndAtChars = -1;
  /**
   * Char offset of the end of the most recent open marker
   * (`<tool_call>`, `<function=`, `<|channel>`, …). -1 until first
   * seen. Persistent across scan windows so a chunk of pure body
   * content (no markers in this window) doesn't lose the fact that
   * we're inside an unclosed call. Compared against
   * `lastCloseEndAtChars` to compute `insideUnclosedCall`.
   */
  private lastOpenEndAtChars = -1;
  /**
   * True iff the most recent OPEN marker has not yet been matched by
   * a CLOSE marker — i.e., the model is mid-tool-call. While true,
   * `observeContent` uses the looser cold `threshold` instead of the
   * tight `postActionThreshold`.
   */
  private insideUnclosedCall = false;
  /**
   * Char offsets of the most recent `<think>` / `<reasoning>` open and
   * close markers. -1 until first seen; persistent across scan windows
   * for the same reason the tool-call open/close offsets are (a chunk
   * of pure reasoning body carries no markers and must not reset the
   * flag).
   *
   * Wild-caught (qwen3.6 a3b consultation): verbose-family
   * models wrap chain-of-thought in `<think>…</think>` — a reasoning
   * format the original detector did NOT recognize (it special-cased
   * `<|channel>` tags for Gemma 4 / gpt-oss but not `<think>`). Qwen
   * opened `<think>`, reasoned ~6 KB drafting the deliverable, and the
   * cold cap fired at 6001 chars BEFORE it closed `</think>` and
   * emitted the `write_file` call. Treating an unclosed reasoning span
   * like an unclosed tool-call body (loose `insideCallThreshold`)
   * lets the reasoning complete; the close marker then anchors the
   * prose counter so post-reasoning narration is measured fresh.
   */
  private lastReasoningOpenEndAtChars = -1;
  private lastReasoningCloseEndAtChars = -1;
  /**
   * True iff the most recent reasoning OPEN marker has not yet been
   * matched by a reasoning CLOSE marker — i.e., the model is mid
   * chain-of-thought. While true, `observeContent` uses the loose
   * `insideCallThreshold` (reasoning is legitimate work, not ramble).
   */
  private insideReasoning = false;
  /**
   * Char offset of the end of the most recent markdown fenced-code-block
   * marker (```` ``` ```` / `~~~` at line start). -1 until first seen;
   * persistent across scan windows and deduped so the lookback overlap
   * can't double-count one marker. Markdown fences are TOGGLES — the same
   * marker opens and closes — so {@link insideFencedCode} is the parity
   * of how many markers we've passed.
   */
  private lastFenceMarkerEndAtChars = -1;
  /**
   * True iff an odd number of fence markers have been seen — i.e. the
   * model is mid-fenced-code-block. Verbose models that leak UNTAGGED
   * reasoning sometimes "chat-code" a whole file inside a ```` ```lang ````
   * fence instead of a `write_file` body; that file is real work, not
   * ramble, so an open fence gets the loose inside-call budget exactly
   * like an unclosed tool body or reasoning span. Wild-caught
   * (qwen3.6 a3b consultation): a ~16 KB `index.html` streamed
   * inside ```` ```html ```` was guillotined at the 12 KB doubled-cold cap
   * mid-file, before the fence closed — so code-block salvage had only a
   * truncated block to recover and the write was lost.
   */
  private insideFencedCode = false;
  private aborted = false;
  /**
   * True iff the abort that set {@link aborted} fired on the repetition
   * guard (low trigram novelty) rather than a length cap. Surfaced for
   * log attribution so the abort message reads "stuck in a planning
   * loop" instead of the misleading "cold ramble (12000 chars)".
   */
  private repetitionFired = false;

  constructor(opts: RambleDetectorOpts) {
    this.threshold = opts.threshold;
    this.coldThreshold = opts.leakyReasoning
      ? Math.round(opts.threshold * LEAKY_REASONING_COLD_MULTIPLIER)
      : opts.threshold;
    // Default the post-action cap to a quarter of cold — meaningfully
    // tighter so the model can't burn another full budget rambling
    // after engaging tools, but generous enough to absorb a normal
    // tail comment ("read these → here's what's next").
    this.postActionThreshold =
      opts.postActionThreshold ?? Math.max(500, Math.floor(opts.threshold / 4));
    this.insideCallThreshold = opts.insideCallThreshold ?? Math.max(32_000, opts.threshold * 5);
    this.enabled = opts.enabled;
    this.repetitionGuardEnabled = opts.repetitionGuardEnabled ?? opts.enabled;
    this.repetitionWindow = opts.repetitionWindow ?? DEFAULT_REPETITION_WINDOW;
    this.repetitionMinNovelty = opts.repetitionMinNovelty ?? DEFAULT_REPETITION_MIN_NOVELTY;
    // Seed the reasoning span as already open at offset 0 — exactly the
    // state an observed `<think>` at the head of the stream would leave
    // us in. `observeContent` recomputes `insideReasoning` from these
    // offsets on its first scan; the field is set here too so the
    // getters read true before any content arrives.
    if (opts.opensInReasoning) {
      this.lastReasoningOpenEndAtChars = 0;
      this.insideReasoning = true;
    }
  }

  /**
   * Fraction of word-trigrams in `text` that are distinct. 1.0 = every
   * 3-word shingle is unique (healthy, progressing prose); near 0 = the
   * same phrases repeat (a planning loop). Returns the distinct-word
   * count alongside so the caller can require real lexical variety
   * before trusting a low ratio. Cheap: one pass, normalized to
   * lowercase alphanumerics so punctuation/casing don't inflate novelty.
   */
  private static trigramNovelty(text: string): { ratio: number; distinctWords: number } {
    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter(Boolean);
    if (words.length < 3) return { ratio: 1, distinctWords: new Set(words).size };
    const distinctWords = new Set(words).size;
    const total = words.length - 2;
    const shingles = new Set<string>();
    for (let i = 0; i < total; i++) {
      shingles.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    }
    return { ratio: shingles.size / total, distinctWords };
  }

  /**
   * Record that a structured tool-call delta arrived from the
   * provider. Resets the counter so subsequent prose is measured
   * against this point AND switches the detector into post-action
   * mode (tighter threshold). Idempotent.
   */
  recordStructuredAction(currentTurnLength: number): void {
    if (!this.active) return;
    this.lastActionAtChars = currentTurnLength;
    this.scannedUpTo = currentTurnLength;
    this.hasSeenAction = true;
  }

  /**
   * Update the detector with the current accumulated turn content.
   * Scans the new tail (not the whole string) for tool-call markup.
   * Returns true the first time the threshold trips; subsequent
   * calls return false (the caller is expected to abort).
   */
  observeContent(turnContent: string): boolean {
    if (!this.active || this.aborted) return false;
    if (turnContent.length > this.scannedUpTo) {
      // Lookback handles markup that straddles the previous boundary
      // (e.g. `<tool_` arrived last chunk, `call>` arrives now).
      const lookbackStart = Math.max(this.scannedUpTo - 16, 0);
      const window = turnContent.slice(lookbackStart);
      // Anchor at the END of the matched marker so the marker itself
      // doesn't count as "prose since action" — distance is measured
      // from the close of `<tool_call>` / `<function=`, not the start.
      //
      // Channel-tag markers (`<|channel>`, `<|channel|>`, `<channel|>`)
      // count as action signals too. Gemma 4 26B (and gpt-oss family)
      // legitimately reason for thousands of characters wrapped in
      // these tags before emitting a tool call; without recognizing
      // them as "the model is doing work," cold-mode ramble fires
      // prematurely and aborts the turn just before the actual tool
      // call lands. The strip-channel-tags behavior captures the
      // wrapped reasoning into ChatMessage.reasoning after SSE-EXIT,
      // so counting these as actions is consistent with how the
      // wrapped content is treated downstream.
      //
      // CRITICAL: the post-action cap (typ. 1500 chars) is meant for
      // prose that follows a CLOSED tool call. When the model is
      // still INSIDE an unclosed `<function=NAME>…` writing a long
      // parameter value (e.g. a write_file body), the content between
      // open and close is part of the action itself — not prose since
      // an action. Tracking open and close markers separately lets
      // us exempt mid-tool-call content from the tight post-action
      // cap; only AFTER the call closes does prose-since-action start
      // accumulating.
      //
      // Wild-caught on Qwen 3.6 27B (MLX, tictactoe trials):
      // Tamara emits `<tool_call><function=write_file><parameter=content>…`
      // and the post-action cap fires at 1502 chars into the HTML body
      // — long before the `</function>` closer. The 5 dropped tool
      // calls per trial were the dominant failure mode.
      const actionRe = /<tool_call>|<function=|<\|?\/?channel\|?>/gi;
      const toolOpenRe = /<tool_call>|<function=/gi;
      const closeRe = /<\/tool_call\s*>|<\/function\s*>/gi;
      // Reasoning spans (`<think>` / `<reasoning>`) are progress, not
      // ramble — verbose-family models reason here before acting. An
      // unclosed reasoning span gets the loose inside-call budget; the
      // close anchors the prose counter so post-reasoning narration is
      // measured fresh. NOT folded into `actionRe`: a reasoning marker
      // must not set `hasSeenAction` (it's not a tool call) and a lone
      // `<think>` near offset 0 wouldn't help a 6 KB monologue — the
      // open/close SPAN tracking is what grants the budget.
      const reasoningOpenRe = /<think\s*>|<reasoning\s*>/gi;
      const reasoningCloseRe = /<\/think\s*>|<\/reasoning\s*>/gi;
      const previousActionAtChars = this.lastActionAtChars;
      let lastActionEnd = -1;
      for (const m of window.matchAll(actionRe)) {
        lastActionEnd = m.index + m[0].length + lookbackStart;
      }
      let lastToolOpenEnd = -1;
      for (const m of window.matchAll(toolOpenRe)) {
        lastToolOpenEnd = m.index + m[0].length + lookbackStart;
      }
      let lastCloseEnd = -1;
      for (const m of window.matchAll(closeRe)) {
        lastCloseEnd = m.index + m[0].length + lookbackStart;
      }
      if (lastActionEnd >= 0 && lastActionEnd > this.lastActionAtChars) {
        this.lastActionAtChars = lastActionEnd;
      }
      // Channel markers are progress signals, but they are not tool
      // calls. They reset the cold counter without switching to
      // post-action mode or the loose inside-call body budget.
      if (lastToolOpenEnd >= 0 && lastToolOpenEnd > previousActionAtChars) {
        this.hasSeenAction = true;
      }
      // CRITICAL: track open marker positions persistently across
      // scan windows. The first version of the open/close-span fix
      // computed `insideUnclosedCall` from the LOCAL scan results,
      // which meant a window containing no markers (i.e. pure HTML
      // body inside a write_file) silently reset the flag to false —
      // the post-action cap then fired on the body content even
      // though we were clearly still inside an unclosed `<function=`.
      // The fix: persist the most recent open position on `this` so
      // it survives scans that see only body content.
      //
      // Wild-caught (qwen3.6 matrix): every trial truncated
      // at ~1500 chars into the write_file body despite the prior fix
      // — the write_file opener arrived in one stream chunk, the
      // body streamed across many subsequent chunks, and each chunk's
      // local-only scan saw zero markers and reset the flag.
      if (lastToolOpenEnd >= 0 && lastToolOpenEnd > this.lastOpenEndAtChars) {
        this.lastOpenEndAtChars = lastToolOpenEnd;
      }
      // A close after the most recent open ends the call span; anchor
      // the post-action prose counter at the close. Subsequent prose
      // is measured against the tighter `postActionThreshold`.
      if (lastCloseEnd >= 0 && lastCloseEnd > this.lastActionAtChars) {
        this.lastActionAtChars = lastCloseEnd;
        this.lastCloseEndAtChars = lastCloseEnd;
      }
      // Are we currently INSIDE an unclosed tool-call span? Compare
      // PERSISTENT open vs close offsets — not per-window locals.
      this.insideUnclosedCall =
        this.lastOpenEndAtChars >= 0 && this.lastOpenEndAtChars > this.lastCloseEndAtChars;
      // Same persistent open/close tracking for reasoning spans.
      let lastReasoningOpenEnd = -1;
      for (const m of window.matchAll(reasoningOpenRe)) {
        lastReasoningOpenEnd = m.index + m[0].length + lookbackStart;
      }
      let lastReasoningCloseEnd = -1;
      for (const m of window.matchAll(reasoningCloseRe)) {
        lastReasoningCloseEnd = m.index + m[0].length + lookbackStart;
      }
      if (lastReasoningOpenEnd >= 0 && lastReasoningOpenEnd > this.lastReasoningOpenEndAtChars) {
        this.lastReasoningOpenEndAtChars = lastReasoningOpenEnd;
      }
      // A reasoning close ends the chain-of-thought: anchor the prose
      // counter at the close so the visible answer that follows starts
      // accumulating from zero (against the cold cap), not from the
      // start of the reasoning block.
      if (lastReasoningCloseEnd >= 0 && lastReasoningCloseEnd > this.lastReasoningCloseEndAtChars) {
        this.lastReasoningCloseEndAtChars = lastReasoningCloseEnd;
        if (lastReasoningCloseEnd > this.lastActionAtChars) {
          this.lastActionAtChars = lastReasoningCloseEnd;
        }
      }
      this.insideReasoning =
        this.lastReasoningOpenEndAtChars >= 0 &&
        this.lastReasoningOpenEndAtChars > this.lastReasoningCloseEndAtChars;
      // Markdown fenced code blocks (```` ```lang ```` / `~~~`). Unlike
      // the tagged spans above, a fence is a TOGGLE — the same marker
      // both opens and closes — so we flip `insideFencedCode` on each
      // NEW marker (deduped by end offset so the 16-char lookback can't
      // count one marker twice). A fence that just CLOSED anchors the
      // prose counter at the close, so narration after the block is
      // measured fresh (mirrors the reasoning/tool-call close anchors).
      const fenceRe = /(?:^|\n)[ \t]*(?:```|~~~)/g;
      for (const m of window.matchAll(fenceRe)) {
        const end = m.index + m[0].length + lookbackStart;
        if (end > this.lastFenceMarkerEndAtChars) {
          this.lastFenceMarkerEndAtChars = end;
          this.insideFencedCode = !this.insideFencedCode;
          if (!this.insideFencedCode && end > this.lastActionAtChars) {
            this.lastActionAtChars = end;
          }
        }
      }
      this.scannedUpTo = turnContent.length;
    }
    const proseSinceAction = turnContent.length - this.lastActionAtChars;
    // Repetition guard — fires on a planning LOOP before the length cap
    // would. A length cap can't distinguish a long-but-progressing plan
    // from a model re-emitting the same sentences; trigram novelty can.
    // Active only in natural-prose modes: exempt while inside an
    // unclosed tool-call body (boilerplate HTML/code legitimately
    // repeats) and inside a reasoning span (a chain-of-thought may
    // revisit an idea). Measured over the trailing window of
    // prose-since-action so an earlier tool body never pollutes the
    // sample. Wild-caught (qwen3.6 voorman): with the leaky
    // 2× cold budget the model circled four hypotheses for ~12 KB and
    // only aborted on length; this catches it at ~one window.
    if (
      this.repetitionGuardEnabled &&
      this.repetitionMinNovelty > 0 &&
      !this.insideUnclosedCall &&
      !this.insideReasoning &&
      !this.insideFencedCode &&
      proseSinceAction >= this.repetitionWindow
    ) {
      const regionStart = Math.max(
        this.lastActionAtChars,
        turnContent.length - this.repetitionWindow,
      );
      const { ratio, distinctWords } = RambleDetector.trigramNovelty(
        turnContent.slice(regionStart),
      );
      if (distinctWords >= REPETITION_MIN_DISTINCT_WORDS && ratio < this.repetitionMinNovelty) {
        this.aborted = true;
        this.repetitionFired = true;
        return true;
      }
    }
    // Threshold selection — three tiers, by what the model is doing:
    //   - Inside an unclosed tool call (write_file body, etc.): give
    //     the model a MUCH higher budget. The "prose since action"
    //     here is actually the tool-call's parameter body, which a
    //     real tank-combat game or write_artifact payload can easily
    //     run to many KB. Wild-caught (matrix): tankcombat
    //     trials capped at the 6KB cold threshold while INSIDE the
    //     write_file call — the script truncated, the file became a
    //     facade. Bump to 32 KB so legitimate large file writes
    //     complete; the supervisor's turn-deadline (3 min default)
    //     remains the ultimate guardrail against runaway calls.
    //   - Post-action prose (called a tool, now narrating): tight
    //     `postActionThreshold` (~1500). Catches planning paralysis
    //     between tool calls.
    //   - Cold (no tools yet, just prose): the looser `threshold`
    //     (~6000). Long pre-tool monologues abort here.
    // Length caps are the verbose-family surface: a legitimate long
    // prose answer on a non-verbose model can exceed the cold cap, so
    // they stay gated on `enabled`. The repetition guard above is the
    // only protection a repetition-guard-only detector applies.
    if (this.enabled) {
      const effectiveThreshold =
        this.insideUnclosedCall || this.insideReasoning || this.insideFencedCode
          ? this.insideCallThreshold
          : this.hasSeenAction
            ? this.postActionThreshold
            : this.coldThreshold;
      if (proseSinceAction >= effectiveThreshold) {
        this.aborted = true;
        return true;
      }
    }
    return false;
  }

  /**
   * True when EITHER gate is live — the detector does real work. When
   * both are off it is a full no-op (the early return in
   * {@link observeContent} / {@link recordStructuredAction}).
   */
  private get active(): boolean {
    return this.enabled || this.repetitionGuardEnabled;
  }

  /**
   * Which threshold the next observation will be measured against.
   * Exposed for log attribution so the abort message can say
   * "post-action ramble" vs "cold ramble" without the caller
   * having to track state separately.
   */
  get activeThreshold(): number {
    return this.insideUnclosedCall || this.insideReasoning || this.insideFencedCode
      ? this.insideCallThreshold
      : this.hasSeenAction
        ? this.postActionThreshold
        : this.coldThreshold;
  }

  /**
   * True iff the model is currently inside an unclosed markdown fenced
   * code block — "chat-coding" a file in prose. Surfaced for log
   * attribution and so the provider's salvage path can recognize that an
   * abort happened around a code-block the model meant for a file.
   */
  get isInsideFencedCode(): boolean {
    return this.insideFencedCode;
  }

  /** True once any tool-call signal has appeared this iteration. */
  get inPostActionMode(): boolean {
    return this.hasSeenAction && !this.insideUnclosedCall;
  }

  /**
   * True iff the model is currently emitting content inside an
   * unclosed `<function=…>` / `<tool_call>` block. Surfaced for log
   * attribution so abort messages can distinguish "rambled inside an
   * unclosed call" (rare; only fires at the looser cold threshold)
   * from "rambled after a closed call" (the common post-action case).
   */
  get isInsideUnclosedCall(): boolean {
    return this.insideUnclosedCall;
  }

  /**
   * True iff the model is currently inside an unclosed `<think>` /
   * `<reasoning>` span. Surfaced for log attribution so an abort that
   * fires on a runaway reasoning block (past the loose inside-call
   * budget) reads as "reasoning" rather than the misleading "cold".
   */
  get isInsideReasoning(): boolean {
    return this.insideReasoning;
  }

  get hasAborted(): boolean {
    return this.aborted;
  }

  /**
   * True iff the abort fired on the repetition guard (a planning loop)
   * rather than a length cap. For log attribution only.
   */
  get firedOnRepetition(): boolean {
    return this.repetitionFired;
  }

  /**
   * For debug logging — how many chars of prose have accumulated
   * since the last action signal at the moment the detector fired.
   */
  get proseSinceLastAction(): number {
    return Math.max(0, this.scannedUpTo - this.lastActionAtChars);
  }
}
