/**
 * Pin-time policy for the generic build-loop: given a job's deliverable path
 * and brief text, decide which specialist capability and acceptance sniff its
 * automated gate + advanceWhen should enforce. Kept as a pure module (no
 * server/SDK imports) so load-bearing routing decisions remain unit-testable.
 *
 * Authored to the task CLASS, never to an eval's sniff signals: a real-time /
 * arcade game genuinely needs a render surface + frame loop (`html-game`),
 * whereas a turn/board game (tic-tac-toe, chess, sudoku) is legitimately
 * DOM-only and must keep `html-complete` — it would fail `html-game` by design.
 */

/** Action/arcade-game briefs whose genuine quality bar is a canvas + game loop. */
export const ARCADE_GAME_BRIEF =
  /\b(arcade|shooter|shoot(?:'?em)?|space\s*(?:invader|shooter)|tank|dodge|asteroid|invader|platformer|side-?scroll|endless\s*runner|bullet[\s-]*hell|breakout|pong|snake\s*game|flappy|twin-?stick|top-?down)s?\b/i;

/**
 * Arcade briefs that explicitly ask for a multi-screen flow (title → gameplay
 * → game-over → restart). For these the deliverable is not "done" until those
 * screens exist, so the gate additionally requires game-over + restart
 * affordances. This enforces the STATED deliverable shape — not a sniff signal
 * — and is scoped to briefs that actually request it (tankcombat / tic-tac-toe
 * have no such language and are unaffected).
 */
export const MULTI_SCREEN_BRIEF =
  /\b(multi-?screen|title\s*screen|start\s*screen|game\s*-?\s*over|game-?over|restart|play\s*again)\b/i;

export type DeliverableSniff = 'html-complete' | 'html-game' | 'data-table' | 'nonempty';

/** Derived-data deliverable extensions — produced by computation, verified as parseable tables. */
export const DATA_DELIVERABLE_RE = /\.(csv|tsv|json|ndjson)$/i;

/** Raster formats that the built-in `generate_image` tool can save directly. */
export const RASTER_IMAGE_DELIVERABLE_RE = /\.(png|jpe?g|webp)$/i;

export interface DeliverablePolicy {
  /** Deliverable is an .html/.htm file. */
  isHtml: boolean;
  /** Deliverable is a derived-data file (csv/tsv/json/ndjson). */
  isData: boolean;
  /** Deliverable is a raster image produced through `generate_image`. */
  isRasterImage: boolean;
  /** Specialist role that owns production when the generic developer is not capable. */
  suggestedProducerRole?: 'image-generator';
  /** HTML deliverable whose brief reads as a real-time/arcade game. */
  isArcade: boolean;
  /** Arcade brief that asks for title/game-over/restart screens. */
  isMultiScreen: boolean;
  /** The sniff the gate + advanceWhen should enforce for this deliverable. */
  sniff: DeliverableSniff;
}

/**
 * Decide the acceptance sniff for a solo build-loop deliverable.
 * - non-HTML, non-data (review.md, types.ts, PNG) → `nonempty` floor; supported
 *   raster formats additionally route production to `image-generator`.
 * - data files (csv/tsv/json/ndjson) → `data-table`: the deliverable is the
 *   produced, PARSEABLE output — a transform script left at the output path
 *   (or hand-typed junk) must not advance the step.
 * - HTML arcade/action game → `html-game` (render surface + game loop + real JS).
 * - any other HTML (board game, site, app) → `html-complete`.
 */
export function policyForDeliverable(
  deliverablePath: string,
  briefText: string,
): DeliverablePolicy {
  const isHtml = /\.html?$/i.test(deliverablePath);
  const isData = !isHtml && DATA_DELIVERABLE_RE.test(deliverablePath);
  const isRasterImage = !isHtml && RASTER_IMAGE_DELIVERABLE_RE.test(deliverablePath);
  const isArcade = isHtml && ARCADE_GAME_BRIEF.test(briefText);
  const isMultiScreen = isArcade && MULTI_SCREEN_BRIEF.test(briefText);
  const sniff: DeliverableSniff = isHtml
    ? isArcade
      ? 'html-game'
      : 'html-complete'
    : isData
      ? 'data-table'
      : 'nonempty';
  return {
    isHtml,
    isData,
    isRasterImage,
    ...(isRasterImage ? { suggestedProducerRole: 'image-generator' as const } : {}),
    isArcade,
    isMultiScreen,
    sniff,
  };
}

/**
 * The minimum `suggestCraftbooks` score at which the meester HARD-PINS a book's
 * structure into the kickoff task. Embeddings-aware, because the ranker's
 * blended score and its lexical-only fallback live on different scales:
 *
 * - With a semantic component (the all-MiniLM embedding stack available), a
 *   blended score of ~0.5+ is a confident match and 0.3 is a sane floor.
 * - Without embeddings (best-effort — no model cache or local inference; this
 *   is the case for every eval trial), the score collapses to pure lexical
 *   overlap where even a perfect match tops out ~0.18. A flat 0.3 floor is then
 *   unreachable, so the pin silently never fires and the "steered" craftbook
 *   arm degenerates to freeform. (Wild-caught: arcade-deluxe 0/3,
 *   `state.json.craftbook: null`.)
 *
 * So gate lexical-only matches on the 0.15 lexical-suggest floor instead. The
 * `semantic` field's presence on the top suggestion is the mode signal.
 */
export function craftbookPinFloor(topSemantic: number | undefined): number {
  // Lexical floor calibrated against the 203-book catalog
  // with REAL macro briefs (name + taskDescription + about joined — the
  // about prose dilutes token overlap, so live scores run lower than
  // bare-description tests): the live tic-tac-toe brief's correct
  // board-game-web pick scores 0.0999; richer briefs land 0.10-0.25.
  // The old 0.15 rejected every one of them, which silently disabled
  // the craftbook pin (and with it ALL completion gates) on every
  // embeddings-less install — zero gate firings across two full
  // 56-trial eval baselines. 0.07 admits all observed build briefs
  // with margin. Context bounds the mis-pin risk: this floor only
  // gates the meester macros, which run exclusively on committed build
  // briefs — and the solo path attaches the GENERIC build-loop
  // (retargeted onto the real deliverable) regardless of which book
  // matched.
  return typeof topSemantic === 'number' ? 0.3 : 0.07;
}

/** Structural shape of a step tool policy, typed loosely to keep this module import-free. */
export interface RetargetableToolPolicy {
  disallowBuiltinToolsets?: string[];
  allowTools?: string[];
  disallowTools?: string[];
  [key: string]: unknown;
}

/**
 * The built-in toolset, and the tools in it, that the retargeted entry step's
 * prompt tells the producer to call for each non-HTML deliverable class.
 * Undefined when the step needs nothing beyond the book's own surface.
 */
export function producerToolsFor(
  policy: DeliverablePolicy,
): { group: string; tools: string[] } | undefined {
  if (policy.isRasterImage) return { group: 'images', tools: ['generate_image'] };
  if (policy.isData)
    return { group: 'code-execution', tools: ['derive_file', 'run_nodejs_script'] };
  return undefined;
}

/**
 * Re-open the producer's tools on the retargeted entry step's authored tool
 * policy. build-loop is authored for an HTML build and its step policy bans
 * `images` and `code-execution`; retargeting it onto a PNG or a derived CSV
 * rewrites the prompt to name `generate_image` / `derive_file`, so the ceiling
 * has to follow or the step demands a tool it cannot call. The step ceiling is
 * applied after every other grant, including a fixed-function gezel's one
 * tool, so the image-generator failed its first action with "not registered"
 * (wild-caught: tool-routing-image, 2026-09-25). Everything else in the
 * authored policy stays as written.
 */
export function retargetEntryToolPolicy<T extends RetargetableToolPolicy>(
  policy: DeliverablePolicy,
  toolPolicy: T | undefined,
): T | undefined {
  const producer = producerToolsFor(policy);
  if (!producer || !toolPolicy) return toolPolicy;
  const next: T = { ...toolPolicy };
  const groups = next.disallowBuiltinToolsets?.filter((g) => g !== producer.group);
  if (groups?.length) next.disallowBuiltinToolsets = groups;
  else delete next.disallowBuiltinToolsets;
  const deniedTools = next.disallowTools?.filter((t) => !producer.tools.includes(t));
  if (deniedTools?.length) next.disallowTools = deniedTools;
  else delete next.disallowTools;
  if (next.allowTools) next.allowTools = [...new Set([...next.allowTools, ...producer.tools])];
  return next;
}

/** Structural shape of a gate script ref, typed loosely to keep this module import-free. */
export interface RetargetableGateScript {
  name: string;
  scope?: string;
  inputs?: Record<string, unknown>;
}

export interface RetargetableGateCheck {
  kind: string;
  file?: string;
  sniff?: string;
  bytes?: number;
  [key: string]: unknown;
}

/**
 * Repoint a build-loop step gate's two layers onto the real deliverable.
 * The bundled `build-loop` gate is HTML-authored ([minBytes 2048,
 * jsParses] + the `checkHtmlComplete` script), so retargeting is
 * class-aware:
 *
 * - **HTML** — retarget sniff/minBytes checks and script `file` inputs;
 *   keep everything else (the html layers are correct for html).
 * - **data (csv/tsv/json/ndjson)** — replace the check floor with
 *   [minBytes 120, sniff `data-table`] (the small-legit-CSV floor from
 *   core's `gateChecksFloor`; the book's 2048-byte html floor rejects
 *   real outputs) and DROP the gate scripts.
 * - **other non-HTML (md, ts, png)** — retarget sniff/minBytes, drop
 *   `jsParses` (inline-script noise on non-html), and DROP the gate
 *   scripts: `checkHtmlComplete` rejects anything without `</body>`, so
 *   a retargeted review.md/csv gate could never pass its script layer
 *   (the layer was silently unwinnable before this mapping).
 */
export function retargetGateLayers(
  policy: DeliverablePolicy,
  deliverablePath: string,
  gate: { checks?: RetargetableGateCheck[]; scripts?: RetargetableGateScript[] },
  extraChecks: RetargetableGateCheck[] = [],
): { checks: RetargetableGateCheck[]; scripts?: RetargetableGateScript[] } {
  if (policy.isHtml) {
    const checks = [
      ...(gate.checks ?? []).map((c) =>
        c.kind === 'sniff'
          ? { ...c, file: deliverablePath, sniff: policy.sniff }
          : c.kind === 'minBytes'
            ? { ...c, file: deliverablePath }
            : c,
      ),
      ...extraChecks,
    ];
    const scripts = gate.scripts?.map((r) =>
      r.inputs && typeof r.inputs.file === 'string'
        ? { ...r, inputs: { ...r.inputs, file: deliverablePath } }
        : r,
    );
    return { checks, ...(scripts ? { scripts } : {}) };
  }
  if (policy.isData) {
    return {
      checks: [
        { kind: 'minBytes', file: deliverablePath, bytes: 120 },
        { kind: 'sniff', file: deliverablePath, sniff: 'data-table' },
        ...extraChecks,
      ],
    };
  }
  const checks = [
    ...(gate.checks ?? [])
      .filter((c) => c.kind !== 'jsParses' && c.kind !== 'cssMinBytes')
      .map((c) =>
        c.kind === 'sniff'
          ? { ...c, file: deliverablePath, sniff: policy.sniff }
          : c.kind === 'minBytes'
            ? { ...c, file: deliverablePath }
            : c,
      ),
    ...extraChecks,
  ];
  return { checks };
}
