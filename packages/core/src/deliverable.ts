import type { z } from 'zod';
import type {
  AdvanceWhen,
  CraftbookStep,
  GateCheck,
  GateScriptRef,
  NewCraftbookStep,
  StepDeliverable,
  StepGate,
} from './schemas/index.js';
import { DeliverableKindSchema, resolveSteps } from './schemas/index.js';

/**
 * ─ Deliverable gates ─────────────────────────────────────────────────
 *
 * Given the CLASS of artifact a step produces, build the right gate: a cheap
 * declarative floor (`checks`) plus standard-library gate scripts that judge
 * a completion attempt and loop the step back on a miss. This is the wisdom
 * behind the gallery's per-phase gates (`archetypeToCraftbook`) AND the
 * `set_step_deliverable` MCP tool / the plan craftbook — kept here in core
 * (where the gate schema lives) so every consumer can share one source of
 * truth without depending on the catalog package.
 */

/**
 * The CLASS of artifact a step produces. Maps to class-appropriate static
 * gate checks — authored to "what makes ANY deliverable of this class good",
 * never to a specific eval's sniff signals. The enum itself lives in the
 * schemas layer ({@link DeliverableKindSchema}) so the blueprint field and
 * the MCP tools share it without an import cycle.
 */
export type DeliverableKind = z.infer<typeof DeliverableKindSchema>;

/**
 * Infer the deliverable class from a file path when the author didn't say.
 * Deliberately coarse — a `.html` is a page (never a game: that stricter
 * bar must be asked for), code is a module unless the filename says tests.
 */
export function inferDeliverableKind(path: string): DeliverableKind {
  const lower = path.toLowerCase();
  if (/\.(test|spec)\.[a-z]+$/.test(lower)) return 'code-with-tests';
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  switch (ext) {
    case 'html':
    case 'htm':
      return 'html-page';
    case 'md':
    case 'markdown':
      return 'markdown-doc';
    case 'json':
      return 'json';
    case 'yaml':
    case 'yml':
      return 'yaml-spec';
    case 'csv':
    case 'tsv':
      return 'data-file';
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'ts':
    case 'tsx':
    case 'jsx':
    case 'py':
      return 'code-module';
    case 'wav':
    case 'mp3':
    case 'ogg':
    case 'flac':
      return 'audio-file';
    default:
      return 'generic-file';
  }
}

/**
 * Forgiving alias map for model-supplied kind strings — small models write
 * "html", "md", "csv", "code" and should not eat a validation loop for it.
 * Case- and separator-insensitive. Returns null when nothing plausible
 * matches (the caller reports the legal values).
 */
export function coerceDeliverableKind(raw: string): DeliverableKind | null {
  const norm = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  const exact = DeliverableKindSchema.options.find((k) => k === norm);
  if (exact) return exact;
  const aliases: Record<string, DeliverableKind> = {
    html: 'html-page',
    htm: 'html-page',
    page: 'html-page',
    webpage: 'html-page',
    'web-page': 'html-page',
    website: 'html-marketing-site',
    'marketing-site': 'html-marketing-site',
    'landing-page': 'html-marketing-site',
    game: 'html-game',
    'arcade-game': 'html-game',
    'canvas-game': 'html-game',
    'multiscreen-game': 'html-multiscreen-game',
    md: 'markdown-doc',
    markdown: 'markdown-doc',
    doc: 'markdown-doc',
    document: 'markdown-doc',
    report: 'markdown-report',
    notes: 'markdown-notes',
    note: 'markdown-notes',
    spec: 'yaml-spec',
    yaml: 'yaml-spec',
    yml: 'yaml-spec',
    openapi: 'yaml-spec',
    code: 'code-module',
    module: 'code-module',
    script: 'code-module',
    source: 'code-module',
    js: 'code-module',
    ts: 'code-module',
    javascript: 'code-module',
    typescript: 'code-module',
    python: 'code-module',
    test: 'code-with-tests',
    tests: 'code-with-tests',
    'with-tests': 'code-with-tests',
    images: 'image-set',
    image: 'image-set',
    icons: 'image-set',
    audio: 'audio-file',
    sound: 'audio-file',
    slides: 'slide-deck',
    deck: 'slide-deck',
    presentation: 'slide-deck',
    csv: 'data-file',
    tsv: 'data-file',
    data: 'data-file',
    dataset: 'data-file',
    table: 'data-file',
    file: 'generic-file',
    generic: 'generic-file',
  };
  return aliases[norm] ?? null;
}

const GAME_OVER_PATTERN = 'game\\s*-?\\s*over|you\\s+(?:win|won|lose|lost|died|die)|defeat|victory';
const RESTART_PATTERN =
  'restart|play\\s*again|try\\s*again|new\\s+game|press\\s+\\S+\\s+to\\s+(?:restart|play|start)';
const MARKDOWN_HEADERS = '(?:^|\\n)#{1,3}\\s+\\S';

/**
 * The CHEAP declarative floor for a produced artifact: evaluated
 * in-process by the gate engine with zero sandbox spawns, so trivially
 * incomplete work is rejected before any gate script runs.
 */
function gateChecksFloor(kind: DeliverableKind, path: string, minBytes?: number): GateCheck[] {
  const mb = (fallback: number): GateCheck => ({
    kind: 'minBytes',
    file: path,
    bytes: minBytes ?? fallback,
  });
  switch (kind) {
    case 'html-game':
      return [mb(1500)];
    case 'html-multiscreen-game':
      return [mb(2500)];
    case 'html-page':
      return [mb(800)];
    case 'html-marketing-site':
      return [mb(1200)];
    case 'markdown-doc':
      return [mb(500)];
    case 'markdown-report':
      return [mb(1500)];
    case 'markdown-notes':
      return [mb(120), { kind: 'sniff', file: path, sniff: 'nonempty' }];
    case 'json':
      return [mb(2)];
    case 'yaml-spec':
      return [mb(200), { kind: 'sniff', file: path, sniff: 'nonempty' }];
    case 'code-module':
      // esmImports is a no-op for non-ESM/non-node:import files (returns ok),
      // so it's safe on any source file but catches the wrong-builtin import
      // / require()-in-.mjs class of load-time break. sourceParses is the
      // structural floor that closes the truncated-file hole a byte count
      // waves through: the deliverable must actually parse as source.
      return [
        mb(200),
        { kind: 'sniff', file: path, sniff: 'nonempty' },
        { kind: 'esmImports', file: path },
        { kind: 'sourceParses', file: path },
      ];
    case 'code-with-tests':
      return [
        mb(300),
        { kind: 'sniff', file: path, sniff: 'nonempty' },
        { kind: 'esmImports', file: path },
        { kind: 'sourceParses', file: path },
      ];
    case 'security-report':
      // The prose floor; the real judgment (findings cite real files, systemic
      // themes, verdict consistency) is the checkSecurityReport gate script.
      return [mb(1500)];
    case 'image-set':
      // A count over the workspace listing is itself zero-spawn — stays
      // declarative rather than becoming a script.
      return [{ kind: 'fileCount', ext: ['png', 'jpg', 'jpeg', 'svg', 'webp'], min: 3, dir: path }];
    case 'audio-file':
      return [mb(1000)];
    case 'slide-deck':
      return [mb(600)];
    case 'data-file':
      // The data deliverable is the produced, PARSEABLE output — not the
      // transform script that would produce it. The data-table sniff
      // rejects an empty file or a script left in the output's place and
      // loops the builder back, the data-class analogue of the html
      // floors. Authored to the class, not any specific record schema
      // (that's `extraChecks` via set_step_deliverable when known).
      return [mb(120), { kind: 'sniff', file: path, sniff: 'data-table' }];
    default:
      return [mb(80), { kind: 'sniff', file: path, sniff: 'nonempty' }];
  }
}

/**
 * The RICH judgments for a produced artifact, as standard-library gate
 * scripts (`scope: 'standard'` — packed into the app, trusted to run
 * under any security policy). These produce prescriptive rejection
 * messages a builder can act on directly (e.g. checkJsParses names the
 * syntax error / truncation), which is the whole point of script gates
 * over bare checks. Deterministic literal mapping — keep it that way so
 * regeneration is byte-stable.
 */
function gateScriptsForKind(kind: DeliverableKind, path: string): GateScriptRef[] {
  const std = (name: string, inputs: Record<string, unknown>): GateScriptRef => ({
    name,
    scope: 'standard',
    inputs,
  });
  switch (kind) {
    case 'html-game':
      // checkJsParses is a deliberate TIGHTENING over the old html-game
      // sniff: a page whose inline JS doesn't parse now rejects with the
      // exact syntax error instead of slipping through to evaluate.
      return [std('checkHtmlGame', { file: path }), std('checkJsParses', { file: path })];
    case 'html-multiscreen-game':
      return [
        std('checkHtmlGame', { file: path }),
        std('checkJsParses', { file: path }),
        std('checkContains', { file: path, pattern: GAME_OVER_PATTERN, flags: 'i' }),
        std('checkContains', { file: path, pattern: RESTART_PATTERN, flags: 'i' }),
      ];
    case 'html-page':
      return [std('checkHtmlComplete', { file: path })];
    case 'html-marketing-site':
      return [
        std('checkHtmlComplete', { file: path }),
        std('checkCssMinBytes', { file: path, minBytes: 600 }),
      ];
    case 'markdown-doc':
    case 'markdown-report':
      return [std('checkContains', { file: path, pattern: MARKDOWN_HEADERS, flags: 'i' })];
    case 'json':
      return [std('checkJsonValid', { file: path })];
    case 'code-with-tests':
      return [
        std('checkContains', {
          file: path,
          pattern: '\\b(test|describe|it|assert|expect)\\b',
          flags: 'i',
        }),
      ];
    case 'slide-deck':
      return [
        std('checkContains', { file: path, pattern: '(?:slide|section|^---$)', flags: 'im' }),
      ];
    case 'security-report': {
      // Findings JSON sits beside the report; derive its path from the report dir.
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
      return [std('checkSecurityReport', { file: path, findings: `${dir}findings.json` })];
    }
    default:
      // markdown-notes / yaml-spec / code-module / image-set / audio /
      // data / generic: the declarative floor is the whole bar.
      return [];
  }
}

/**
 * The completion gate for a step that produces a checkable artifact.
 * `onReject: <the step itself>` re-activates the step with a fresh
 * handoff session on every rejection — byte-for-byte the loop dynamics
 * that carried small models through the old evaluator-step shape, with
 * the judgment now made at completion time on the working step.
 */
export function completionGate(
  produces: { path: string; kind: DeliverableKind; minBytes?: number; extraChecks?: GateCheck[] },
  selfId: string,
  maxAttempts: number,
): StepGate {
  const scripts = gateScriptsForKind(produces.kind, produces.path);
  return {
    at: 'completion',
    checks: [
      ...gateChecksFloor(produces.kind, produces.path, produces.minBytes),
      ...(produces.extraChecks ?? []),
    ],
    ...(scripts.length > 0 ? { scripts } : {}),
    onReject: selfId,
    maxAttempts,
  };
}

/** The structural sniff used by a step's `advanceWhen` to leave the step once its artifact lands. */
export function advanceSniffForKind(kind: DeliverableKind): AdvanceWhen['sniff'] {
  if (kind === 'json') return 'json-valid';
  if (kind.startsWith('html')) return 'html-complete';
  return 'nonempty';
}

/**
 * Build the `{ advanceWhen, gate }` pair for a step that produces a single
 * checkable file deliverable — byte-for-byte the shape `archetypeToCraftbook`
 * puts on a gated build phase, exposed so callers outside the generator (the
 * plan craftbook and the `set_step_deliverable` MCP tool) can attach a
 * "concrete static outcome + enforced gate" to any step without hand-writing
 * gate JSON.
 *
 * `advanceWhen` auto-advances the step the moment the artifact lands; the
 * completion `gate` (cheap declarative floor + standard-library gate scripts)
 * judges every completion attempt and re-activates the step (`onReject:
 * selfId`) on a miss.
 */
export function deliverableStep(opts: {
  selfId: string;
  path: string;
  kind: DeliverableKind;
  minBytes?: number;
  extraChecks?: GateCheck[];
  maxAttempts?: number;
  /** Gate the artifacts drawer instead of the workspace. Artifact gates
   * keep only the checks that can read the drawer (`artifact`-capable
   * kinds) and drop workspace-reading gate scripts. */
  artifact?: boolean;
  /** The deliverable is an EDIT — hold the step until the file is written to this turn. */
  requireChange?: boolean;
  /**
   * Code deliverables ONLY: additionally execute in the sandbox and
   * require exit 0 (`nodeRuns`). Data deliverables ignore it — executing
   * `node out/customers.json` is meaningless; their execution story is
   * "produce the file BY running a script" (the `derive_file` tool), and
   * their gate verifies the OUTPUT's shape via `columns`/`minRows` plus
   * the data-table sniff floor.
   */
  execute?: boolean;
  /** Data deliverables: required column/field names (csvShape for CSV, recordSchema for JSON). */
  columns?: string[];
  /** Data deliverables: minimum row count. */
  minRows?: number;
  /**
   * The step is terminal — return the completion gate ONLY (legal and
   * meaningful on a terminal step: its reject blocks task completion)
   * and no `advanceWhen` (illegal there: nowhere to auto-advance to).
   * Models put deliverables on their final "verify" step constantly —
   * the eval A/B's #1 rejection was exactly this shape — so the sugar
   * expands to what a terminal step CAN carry instead of bouncing.
   */
  terminal?: boolean;
}): { advanceWhen?: AdvanceWhen; gate: StepGate } {
  const extraChecks: GateCheck[] = [...(opts.extraChecks ?? [])];
  const isCode = opts.kind === 'code-module' || opts.kind === 'code-with-tests';
  if (opts.execute && isCode) {
    extraChecks.push({ kind: 'nodeRuns', file: opts.path });
  }
  const isData = opts.kind === 'data-file' || opts.kind === 'json';
  if (isData && (opts.columns || opts.minRows !== undefined)) {
    if (/\.(csv|tsv)$/i.test(opts.path)) {
      extraChecks.push({
        kind: 'csvShape',
        file: opts.path,
        ...(opts.columns ? { requiredColumns: opts.columns } : {}),
        ...(opts.minRows !== undefined ? { minRows: opts.minRows } : {}),
      });
    } else if (opts.columns) {
      extraChecks.push({
        kind: 'recordSchema',
        file: opts.path,
        fields: opts.columns.map((name) => ({ name })),
        ...(opts.minRows !== undefined ? { minRows: opts.minRows } : {}),
      });
    }
    // minRows without columns on a non-CSV data file has no zero-spawn
    // check to carry it — the data-table sniff floor still applies.
  }
  const produces = {
    path: opts.path,
    kind: opts.kind,
    ...(opts.minBytes !== undefined ? { minBytes: opts.minBytes } : {}),
    ...(extraChecks.length > 0 ? { extraChecks } : {}),
  };
  const gate = completionGate(produces, opts.selfId, opts.maxAttempts ?? 3);
  if (opts.artifact) {
    // Only minBytes / sniff / contains checks can read the artifacts
    // drawer; the rest (and the stdlib gate scripts) read the workspace
    // and would judge the wrong tree — keep the honest subset.
    gate.checks = (gate.checks ?? [])
      .filter((c) => c.kind === 'minBytes' || c.kind === 'sniff' || c.kind === 'contains')
      .map((c) => ({ ...c, artifact: true }) as GateCheck);
    delete gate.scripts;
  }
  if (opts.terminal) {
    // A terminal step has no outgoing edge: onReject-to-self is still the
    // loop that carries small models, but there is no advanceWhen.
    return { gate };
  }
  return {
    advanceWhen: {
      file: opts.path,
      minBytes: 1,
      sniff: advanceSniffForKind(opts.kind),
      ...(opts.artifact ? { artifact: true } : {}),
      ...(opts.requireChange ? { requireChange: true } : {}),
    },
    gate,
  };
}

/* ─────────────────── Blueprint deliverable expansion ─────────────────── */

/**
 * Expand a blueprint's `deliverable` sugar into the class-appropriate
 * `advanceWhen` + completion `gate` on the resolved step. An explicitly-
 * authored `gate` / `advanceWhen` on the step WINS over the corresponding
 * expanded field — the sugar fills gaps, it never overrides intent.
 * `step.id` must be the FINAL minted id (post de-dup): the expanded gate
 * loops back with `onReject: step.id`.
 */
export function expandStepDeliverable(step: CraftbookStep, d: StepDeliverable): CraftbookStep {
  const kind = d.kind ?? inferDeliverableKind(d.path);
  const { advanceWhen, gate } = deliverableStep({
    selfId: step.id,
    path: d.path,
    kind,
    ...(d.minBytes !== undefined ? { minBytes: d.minBytes } : {}),
    ...(d.maxAttempts !== undefined ? { maxAttempts: d.maxAttempts } : {}),
    ...(d.artifact ? { artifact: true } : {}),
    ...(d.requireChange ? { requireChange: true } : {}),
    ...(d.execute ? { execute: true } : {}),
    ...(d.columns ? { columns: d.columns } : {}),
    ...(d.minRows !== undefined ? { minRows: d.minRows } : {}),
    ...(step.terminal ? { terminal: true } : {}),
  });
  return {
    ...step,
    ...(advanceWhen && !step.advanceWhen ? { advanceWhen } : {}),
    ...(step.advanceWhen ? { advanceWhen: step.advanceWhen } : {}),
    gate: step.gate ?? gate,
  };
}

/**
 * Resolve step blueprints (mint/de-dupe ids) and expand each `deliverable`
 * against the FINAL ids. The one entry point every create path uses —
 * routes, TaskManager inline steps, and the document-write pipeline — so
 * a single `create_task` / `craftbook_write` call yields fully-gated steps.
 */
export function expandStepDeliverables(blueprints: NewCraftbookStep[]): CraftbookStep[] {
  const resolved = resolveSteps(blueprints);
  return resolved.map((step, i) => {
    const d = blueprints[i]?.deliverable;
    return d ? expandStepDeliverable(step, d) : step;
  });
}

/**
 * ─ Inverse inference (D4 step-scoped tool kits) ──────────────────────
 *
 * The persisted step does NOT carry `deliverable.kind` — expansion
 * persists only the derived `advanceWhen` + `gate`. Kit derivation and
 * tier-collapse prompts need the class back, so re-derive it from the
 * expansion's own fingerprints: gate script names, sniffs, check kinds,
 * then the file extension. KIT-accurate by design: the markdown
 * subkinds (doc/report/notes) collapse to `markdown-doc` — they carry
 * identical tool needs, and the floor byte-counts that distinguish them
 * are author-tunable and therefore not a reliable signal.
 */

function stepGateFingerprints(step: Pick<CraftbookStep, 'gate'>): {
  scriptNames: string[];
  scriptInputs: Array<Record<string, unknown>>;
  checkKinds: string[];
  checks: GateCheck[];
} {
  const gate = step.gate;
  const checks: GateCheck[] = gate && 'checks' in gate && gate.checks ? gate.checks : [];
  const scripts: GateScriptRef[] =
    gate && 'scripts' in gate && Array.isArray(gate.scripts)
      ? (gate.scripts as GateScriptRef[])
      : [];
  return {
    scriptNames: scripts.map((s) => s.name),
    scriptInputs: scripts.map((s) => (s.inputs ?? {}) as Record<string, unknown>),
    checkKinds: checks.map((c) => c.kind),
    checks,
  };
}

/** The workspace path a step's deliverable machinery targets, or null. */
export function stepDeliverablePath(
  step: Pick<CraftbookStep, 'advanceWhen' | 'gate'>,
): string | null {
  if (step.advanceWhen?.file) return step.advanceWhen.file;
  const { checks } = stepGateFingerprints(step);
  for (const c of checks) {
    if ('file' in c && typeof c.file === 'string' && c.file) return c.file;
  }
  return null;
}

/**
 * Re-derive the deliverable CLASS from a persisted step. Null when the
 * step targets no file at all (pure-routing / user steps) — callers
 * treat that as "no kit".
 */
export function deliverableKindForStep(
  step: Pick<CraftbookStep, 'advanceWhen' | 'gate'>,
): DeliverableKind | null {
  const path = stepDeliverablePath(step);
  const { scriptNames, scriptInputs, checkKinds } = stepGateFingerprints(step);

  if (scriptNames.includes('checkSecurityReport')) return 'security-report';
  if (scriptNames.includes('checkHtmlGame')) {
    // Multi-screen ships extra contains-checks whose stored pattern
    // strings carry the game-over vocabulary.
    const hasScreenChecks = scriptInputs.some(
      (inp) =>
        typeof inp.pattern === 'string' &&
        inp.pattern.includes('game') &&
        inp.pattern.includes('over'),
    );
    return hasScreenChecks ? 'html-multiscreen-game' : 'html-game';
  }
  if (scriptNames.includes('checkCssMinBytes')) return 'html-marketing-site';
  if (scriptNames.includes('checkHtmlComplete')) return 'html-page';
  if (
    scriptNames.includes('checkContains') &&
    scriptInputs.some((inp) => typeof inp.pattern === 'string' && inp.pattern.includes('slide'))
  ) {
    return 'slide-deck';
  }

  if (step.advanceWhen?.sniff === 'data-table') return 'data-file';
  if (step.advanceWhen?.sniff === 'json-valid') return 'json';
  if (checkKinds.some((k) => k === 'csvShape' || k === 'recordSchema' || k === 'tableShape')) {
    return 'data-file';
  }
  if (checkKinds.includes('fileCount')) return 'image-set';
  if (path && /\.(test|spec)\.[a-z]+$/i.test(path)) return 'code-with-tests';
  if (
    scriptNames.includes('checkContains') &&
    scriptInputs.some(
      (inp) => typeof inp.pattern === 'string' && inp.pattern.includes('test|describe'),
    )
  ) {
    return 'code-with-tests';
  }
  if (checkKinds.includes('sourceParses') || checkKinds.includes('esmImports')) {
    // Only when the target is genuinely source — a markdown step with a
    // stray parse check should not read as code.
    if (path && /\.(js|mjs|cjs|ts|tsx|jsx|py)$/i.test(path)) return 'code-module';
  }

  if (!path) return null;
  return inferDeliverableKind(path);
}

/**
 * The one-line "first action" a small-model step prompt names for a
 * deliverable class (tier-collapse prompts + the tiny-tier task
 * anchor). The named tool is always present in the service-side step
 * kit for the same kind — packages/service/src/chat/step-tool-kit.ts
 * keeps the two in lockstep.
 */
export function firstActionForKind(kind: DeliverableKind, path: string): string {
  switch (kind) {
    case 'data-file':
    case 'json':
      return `derive_file({ script, outputPath: "${path}" })`;
    case 'image-set':
      return `render_image({ prompt, saveAs: "${path}" })`;
    default:
      return `writeFile({ path: "${path}", content: ... })`;
  }
}
