import type { GateCheck } from '@bendyline/gezel';
import { validateFile } from '@bendyline/gezel-mcp';
import {
  type WorkspaceLike,
  buildJudgePrompt,
  citationsResolve,
  containsPattern,
  cssMinBytes,
  csvShape,
  esmImports,
  explainSniff,
  extractInlineScripts,
  fileCountByExt,
  fileMinBytes,
  jsonPathEquals,
  markdownHeadingsMatch,
  notContainsPattern,
  parseJudgeVerdict,
  planStructure,
  recordSchema,
  tableShape,
  totalMinBytes,
  unsupportedClaims,
  validateJudgeEvidence,
  validateScriptSyntax,
  valueGrounding,
  valuesSubsetOf,
  wrapperReturnHint,
} from '@bendyline/gezel/checks';
import ts from 'typescript';
import { runStepSniff } from '../chat/step-sniff.js';
import { parseFrontmatter } from '../index-store/frontmatter.js';

/**
 * Read-only workspace view a static gate evaluates against. Backed by the
 * Store in production; a plain object in tests. Kept tiny so `evaluateGate`
 * stays a pure function of (checks, facts) with no Store/LLM/Playwright dep.
 * Structurally a superset of core/checks' `WorkspaceLike`: the base `read`/
 * `list` hit the shipped workspace; the optional `readArtifact`/
 * `listArtifacts` hit the project's artifacts drawer and back any check
 * flagged `artifact: true`. A reader without the artifact methods simply
 * fails an `artifact`-flagged check as "not found" — the gate never silently
 * passes a deliverable it couldn't read.
 */
export type GateWorkspaceReader = WorkspaceLike & {
  readArtifact?: (file: string) => Promise<string | null>;
  listArtifacts?: () => Promise<string[]>;
  /** Artifact-tree sibling of `WorkspaceLike.readBytes` (image-signature checks). */
  readArtifactBytes?: (file: string) => Promise<Uint8Array | null>;
};

/**
 * Structured outcome of one configured check. Preserved through the gate
 * pipeline so verdict text can quote evidence, plateau detection can hash
 * check IDENTITY (the `label`), and gate telemetry can histogram failing
 * kinds — none of which the joined prose `failures` allow. Service-local:
 * only derived hashes/kind strings persist.
 */
export interface GateCheckOutcome {
  kind: GateCheck['kind'];
  /** Primary file the check examined, when it names one. */
  file?: string;
  /**
   * Stable identity of the CONFIGURED check (kind + file + discriminator,
   * e.g. `contains report.md /Total revenue/`). Prose-free — failure
   * details drift with observed bytes, the label never does, which is
   * what makes it hashable as a plateau signature.
   */
  label: string;
  ok: boolean;
  /** One human line; failing lines are quoted verbatim in the verdict. */
  detail: string;
  /** Machine evidence preserved from the rich CheckResults (arrays sliced to ≤10). */
  evidence?: Record<string, unknown>;
  /**
   * Discrete items this check still wants, for checks that count in items
   * at all (unread corpus records, uncovered paths). Folded into the
   * plateau signature, which is what lets a gate a craftbook is DESIGNED
   * to fail repeatedly — a bounded batch loop — read as progress instead
   * of a stall while the count falls.
   *
   * Only set this where the count is deterministic for a given
   * deliverable: a number that jitters on identical content would reset
   * the ladder forever and hide a real plateau. Leaving it unset keeps
   * the legacy identity-only behavior exactly.
   */
  remaining?: number;
}

export interface GateCheckResult {
  pass: boolean;
  /** One human-readable line per failed check — fed back to the builder as the gap to fix. */
  failures: string[];
  /** Per-check structured outcomes, pass and fail, in configured order. */
  checks: GateCheckOutcome[];
}

/**
 * Side-effecting capabilities a gate evaluation may need, injected by the
 * caller. `sandboxExec` backs the `nodeRuns` check — the ONE spawning
 * check. When absent (pure tests, non-service callers) `nodeRuns`
 * fail-closes with an explanatory rejection rather than silently passing.
 */
export interface GateEvalDeps {
  sandboxExec?: (
    file: string,
    timeoutMs: number,
  ) => Promise<{
    exitCode: number;
    stderrTail: string;
    timedOut: boolean;
    /** Execution refused by security policy — `stderrTail` carries the policy message. */
    denied?: boolean;
  }>;
  /**
   * One-shot LLM executor for `judge` checks — the Keurmeester's
   * frontier consult in production. `{ unavailable }` (rather than a
   * throw) is the judge-not-armed signal that fail-opens the check.
   */
  judgeExec?: (
    prompt: string,
    timeoutMs: number,
  ) => Promise<{ text: string } | { unavailable: string }>;
  /**
   * Observable tool-call evidence for `researchEvidence`. The task manager
   * scopes this to the current task, step, and activation timestamp.
   */
  researchEvidence?: (opts: {
    sourcePath?: string;
    tools: string[];
    minSuccessful: number;
  }) => Promise<{
    observable: boolean;
    matches: Array<{ tool: string; path?: string; target?: string; at?: string }>;
  }>;
  /**
   * Run receipts for `commandEvidence`. The task manager scopes this to
   * the current task, step, and activation timestamp, reading the
   * service-written `workspace.script.run` / `workspace.npx.run` history
   * events — the gate never executes anything itself.
   */
  commandEvidence?: (opts: {
    scope: 'script' | 'npx';
    name: string;
    args: string[];
    minRuns: number;
  }) => Promise<{
    observable: boolean;
    /** The judged task drafts a change proposal — see the check's `onDraft`. */
    drafting?: boolean;
    /** Matching receipts, newest first. */
    runs: Array<{
      exitCode: number;
      timedOut: boolean;
      at?: string;
      stderrTail?: string;
      stdoutTail?: string;
    }>;
  }>;
  /**
   * Paths the TASK ITSELF handed the assignee — invocation parameter
   * values, the step prompt's own backticked path tokens, the artifact
   * working folder. Fed to `citationsResolve` as its `knownPaths`
   * forgiveness set: a deliverable transcribing the run's own metadata
   * (a sources packet recording `tasks/8` or the future
   * `powerpoint/task-8/deck.pptx`) is bookkeeping, not a fabricated
   * citation. Build with {@link taskSuppliedCitationPaths}.
   */
  knownCitationPaths?: readonly string[];
}

/**
 * Collect the path strings a task/step hands its assignee, for
 * {@link GateEvalDeps.knownCitationPaths}. Two sources: every invocation
 * parameter value (non-path params are inert — forgiveness requires exact
 * match against a slash-containing citation), and every backticked
 * slash-containing token in the interpolated step prompt (the procedure's
 * own boundary examples, e.g. "do not reuse an earlier `notes/outline.md`").
 */
export function taskSuppliedCitationPaths(opts: {
  stepPrompt?: string;
  params?: Record<string, string>;
  artifactDir?: string;
}): string[] {
  const out = new Set<string>();
  for (const value of Object.values(opts.params ?? {})) {
    const v = value.trim();
    if (v) out.add(v);
  }
  if (opts.artifactDir?.trim()) out.add(opts.artifactDir.trim());
  for (const m of (opts.stepPrompt ?? '').matchAll(/`([^`\s]*\/[^`\s]+)`/g)) {
    if (m[1]) out.add(m[1]);
  }
  return [...out];
}

/**
 * Evaluate a craftbook gate's static checks against the workspace. ALL
 * checks must pass. Deterministic and cheap — the "ironclad floor" that can
 * never pass junk (objective minimums), only fail-and-loop or escalate.
 * The check logic itself lives in `@bendyline/gezel/checks` so the gate
 * engine, the script stdlib, and the eval harness produce identical
 * verdicts and identical failure prose. (`sourceParses` and `nodeRuns` are
 * the two service-side exceptions: the first uses the TypeScript compiler,
 * the second the injected sandbox executor.)
 */
export async function evaluateGate(
  checks: GateCheck[],
  ws: GateWorkspaceReader,
  deps?: GateEvalDeps,
): Promise<GateCheckResult> {
  // Mechanical-first two-pass: `judge` checks spend a frontier one-shot,
  // so they run only when every mechanical check already passed — no
  // judge spend on a deliverable that is mechanically unfinished.
  const mechanical = checks.filter((c) => c.kind !== 'judge');
  const judges = checks.filter((c) => c.kind === 'judge');
  const outcomes: GateCheckOutcome[] = [];
  for (const c of mechanical) {
    outcomes.push(await evalCheck(c, ws, deps));
  }
  const mechanicalFailed = outcomes.some((o) => !o.ok);
  for (const c of judges) {
    if (mechanicalFailed) {
      outcomes.push({
        kind: c.kind,
        ...('file' in c ? { file: c.file } : {}),
        label: gateCheckLabel(c),
        ok: true,
        detail: `${'file' in c ? c.file : ''}: judge skipped — mechanical checks failed first (no judge spend on unfinished work)`,
        evidence: { judge: { verdict: 'skipped' } },
      });
      continue;
    }
    outcomes.push(await evalCheck(c, ws, deps));
  }
  const failures = outcomes.filter((o) => !o.ok).map((o) => o.detail);
  return { pass: failures.length === 0, failures, checks: outcomes };
}

const NODE_RUNS_DEFAULT_TIMEOUT_MS = 20_000;

/** Cap for evidence arrays carried on a GateCheckOutcome. */
const EVIDENCE_LIST_CAP = 10;

function capList(values: readonly string[]): string[] {
  return values.slice(0, EVIDENCE_LIST_CAP);
}

// Minimal path-glob for `valuesSubsetOf` source entries: a double star
// crosses directory boundaries, a single star stays within one segment,
// everything else is literal. Anchored both ends — "data/*.csv" matches
// exactly one level under data/; a leading double-star prefix matches any
// depth. (Line comments on purpose: glob examples contain star-slash,
// which terminates a block comment.)
function globPathRegExp(glob: string): RegExp {
  // Two-pass star translation via placeholders: a direct sequential
  // replace would let the bare-star pass rewrite the `.*` that the
  // double-star pass just emitted.
  const DEEP = '\u0000';
  const escaped = glob
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, DEEP)
    .replace(/\*/g, '[^/]*')
    .replace(new RegExp(`${DEEP}/`, 'g'), '(?:.*/)?')
    .replace(new RegExp(DEEP, 'g'), '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Stable identity of the configured check — kind + file + the config
 * discriminator (pattern/path/sniff name). Never includes observed
 * values, so it is hash-stable across attempts.
 */
export function gateCheckLabel(c: GateCheck): string {
  switch (c.kind) {
    case 'minBytes':
      return `minBytes ${c.file}`;
    case 'totalMinBytes':
      return `totalMinBytes ${c.files.join('+')}`;
    case 'fileCount':
      return `fileCount ${c.ext.join(',')}${c.dir ? ` ${c.dir}` : ''}`;
    case 'cssMinBytes':
      return `cssMinBytes ${c.file ?? 'index.html'}`;
    case 'sniff':
      return `sniff ${c.file} ${c.sniff}`;
    case 'jsonPathEquals':
      return `jsonPathEquals ${c.file} ${c.path}`;
    case 'csvShape':
      return `csvShape ${c.file}`;
    case 'contains':
      return `contains ${c.file} /${c.pattern}/`;
    case 'notContains':
      return `notContains ${c.file} /${c.pattern}/`;
    case 'unsupportedClaims':
      return `unsupportedClaims ${c.file}`;
    case 'jsParses':
      return `jsParses ${c.file ?? 'index.html'}`;
    case 'htmlLint':
      return `htmlLint ${c.file}`;
    case 'esmImports':
      return `esmImports ${c.file}`;
    case 'sourceParses':
      return `sourceParses ${c.file}`;
    case 'tableShape':
      return `tableShape ${c.file}`;
    case 'recordSchema':
      return `recordSchema ${c.file}`;
    case 'nodeRuns':
      return `nodeRuns ${c.file}`;
    case 'citationsResolve':
      return `citationsResolve ${c.file}`;
    case 'researchEvidence':
      return `researchEvidence ${c.sourcePath?.trim() || c.tools.join(',')}`;
    case 'commandEvidence':
      return `commandEvidence ${c.script?.trim() || c.bin?.trim() || '?'} expect=${c.expect}${c.label ? ` ${c.label}` : ''}`;
    case 'corpusCoverage':
      return `corpusCoverage ${c.file} ${c.corpusDir}`;
    case 'corpusBatches':
      return `corpusBatches ${c.file} ${c.corpusDir}`;
    case 'markdownHeadingsMatch':
      return `markdownHeadingsMatch ${c.file} ${c.outlineFile}`;
    case 'valueGrounding':
      return `valueGrounding ${c.file}`;
    case 'valuesSubsetOf':
      return `valuesSubsetOf ${c.file}`;
    case 'judge':
      return `judge ${c.file}${c.label ? ` ${c.label}` : ''}`;
    case 'planStructure':
      return `planStructure ${c.file}`;
  }
}

function checkFile(c: GateCheck): string | undefined {
  if ('file' in c && typeof c.file === 'string') return c.file;
  if (c.kind === 'cssMinBytes' || c.kind === 'jsParses') return c.file ?? 'index.html';
  return undefined;
}

async function evalCheck(
  c: GateCheck,
  ws: GateWorkspaceReader,
  deps?: GateEvalDeps,
): Promise<GateCheckOutcome> {
  const { ok, detail, evidence, remaining } = await evalCheckInner(c, ws, deps);
  const file = checkFile(c);
  return {
    kind: c.kind,
    ...(file !== undefined ? { file } : {}),
    label: gateCheckLabel(c),
    ok,
    detail,
    ...(evidence !== undefined ? { evidence } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
  };
}

interface InnerOutcome {
  ok: boolean;
  detail: string;
  evidence?: Record<string, unknown>;
  /** See {@link GateCheckOutcome.remaining}. */
  remaining?: number;
}

async function evalCheckInner(
  c: GateCheck,
  ws: GateWorkspaceReader,
  deps?: GateEvalDeps,
): Promise<InnerOutcome> {
  // Checks flagged `artifact: true` resolve `file` against the project's
  // artifacts drawer instead of the workspace. Build a `WorkspaceLike` view
  // whose `read`/`list` hit the artifact store, then run the EXACT same check
  // fns — so the size/shape/content floor is identical whether a deliverable
  // ships in the workspace or lives in the artifacts drawer. When the flag is
  // set but the reader has no artifact accessor (an old/plain reader), fall
  // back to a never-found view so the check fails loudly rather than reading
  // the wrong tree.
  const usesArtifact = (c as { artifact?: boolean }).artifact === true;
  const artifactReader: WorkspaceLike = {
    read: ws.readArtifact ?? (async () => null),
    list: ws.listArtifacts ?? (async () => []),
    // Carry the byte reader across the artifact swap; without it a
    // `verifyImageBytes` check on an artifact deliverable would report
    // "no binary reads" even though the surface supports them.
    ...(ws.readArtifactBytes ? { readBytes: ws.readArtifactBytes.bind(ws) } : {}),
  };
  const reader: WorkspaceLike = usesArtifact ? artifactReader : ws;
  switch (c.kind) {
    case 'minBytes': {
      const r = await fileMinBytes(reader, c.file, c.bytes);
      return { ok: r.ok, detail: r.detail };
    }
    case 'totalMinBytes': {
      const r = await totalMinBytes(reader, c.files, c.bytes);
      return { ok: r.ok, detail: r.detail };
    }
    case 'fileCount': {
      const r = await fileCountByExt(reader, c.ext, c.min, c.dir, {
        ...(c.verifyImageBytes ? { verifyImageBytes: true } : {}),
      });
      const matched = (r as { matched?: string[] }).matched;
      return {
        ok: r.ok,
        detail: r.detail,
        ...(matched ? { evidence: { matched: capList(matched) } } : {}),
      };
    }
    case 'cssMinBytes': {
      const r = await cssMinBytes(reader, c.bytes, c.file);
      return { ok: r.ok, detail: r.detail };
    }
    case 'sniff': {
      const content = await reader.read(c.file);
      if (content === null) {
        return {
          ok: false,
          detail: `${c.file} not found (needed for the ${c.sniff} check)`,
          evidence: { sniff: c.sniff },
        };
      }
      if (runStepSniff(c.sniff, content)) {
        return {
          ok: true,
          detail: `${c.file} passes the ${c.sniff} check`,
          evidence: { sniff: c.sniff },
        };
      }
      // Name the actual gap, not the rule — explainSniff composes the
      // diagnosis from the same primitives the sniff itself uses.
      return {
        ok: false,
        detail: `${c.file} failed the ${c.sniff} check: ${explainSniff(c.sniff, content)}`,
        evidence: { sniff: c.sniff },
      };
    }
    case 'jsonPathEquals': {
      const r = await jsonPathEquals(reader, c.file, c.path, c.value, c.label);
      const actual = (r as { actual?: unknown }).actual;
      return {
        ok: r.ok,
        detail: r.detail,
        ...(actual !== undefined ? { evidence: { actual } } : {}),
      };
    }
    case 'csvShape': {
      const content = await reader.read(c.file);
      const r = csvShape(content, {
        ...(c.requiredColumns ? { requiredColumns: c.requiredColumns } : {}),
        ...(c.exactColumns ? { exactColumns: c.exactColumns } : {}),
        ...(c.minRows !== undefined ? { minRows: c.minRows } : {}),
        ...(c.consistentColumns !== undefined ? { consistentColumns: c.consistentColumns } : {}),
        ...(c.allowedValues ? { allowedValues: c.allowedValues } : {}),
      });
      return {
        ok: r.ok,
        detail: r.ok ? r.detail : `${c.file}: ${r.detail}`,
        evidence: shapeEvidence(r),
      };
    }
    case 'contains': {
      const r = await containsPattern(reader, c.file, c.pattern, c.flags, c.label);
      return { ok: r.ok, detail: r.detail };
    }
    case 'notContains': {
      const r = await notContainsPattern(ws, c.file, c.pattern, c.flags, c.label);
      return { ok: r.ok, detail: r.detail };
    }
    case 'unsupportedClaims': {
      const r = await unsupportedClaims(
        reader,
        c.file,
        c.sourceFiles,
        c.patterns,
        c.flags !== undefined ? { flags: c.flags } : {},
      );
      const violations = (r as { violations?: unknown[] }).violations;
      const missingSources = (r as { missingSources?: string[] }).missingSources;
      return {
        ok: r.ok,
        detail: r.detail,
        evidence: {
          ...(violations ? { violations: violations.slice(0, EVIDENCE_LIST_CAP) } : {}),
          ...(missingSources ? { missingSources: capList(missingSources) } : {}),
        },
      };
    }
    case 'jsParses': {
      const file = c.file ?? 'index.html';
      const content = await reader.read(file);
      if (content === null) {
        return { ok: false, detail: `${file} not found (needed for the inline-JS parse check)` };
      }
      const v = validateScriptSyntax(extractInlineScripts(content));
      // No inline JS → nothing to judge; a page can legitimately ship none.
      if (v.totalBytes === 0) return { ok: true, detail: `${file} has no inline JS to parse` };
      return v.allParse
        ? { ok: true, detail: `${file}: inline JavaScript parses` }
        : {
            ok: false,
            detail: `${file}: inline JavaScript does not parse (${v.firstError ?? 'syntax error'}). The page will not run until the inline <script> parses — fix the broken statement (commonly an unbalanced brace or parenthesis).`,
            ...(v.firstError ? { evidence: { firstError: v.firstError } } : {}),
          };
    }
    case 'htmlLint': {
      const content = await reader.read(c.file);
      if (content === null) {
        return { ok: false, detail: `${c.file} not found (needed for the HTML lint check)` };
      }
      const bytes = new TextEncoder().encode(content);
      const result = validateFile(c.file, { text: content, bytes, totalBytes: bytes.byteLength });
      const failures = result.checks.filter((check) => check.ok === false);
      if (failures.length === 0) {
        return {
          ok: true,
          detail: `${c.file}: HTML structure and inline JavaScript lint checks pass`,
        };
      }
      const first = failures[0]!;
      return {
        ok: false,
        detail: `${c.file}: HTML lint failed (${first.name}: ${first.message})${first.location ? ` at line ${first.location.line}${first.location.col ? `:${first.location.col}` : ''}` : ''}`,
        evidence: { checks: failures.map((failure) => failure.name).slice(0, EVIDENCE_LIST_CAP) },
      };
    }
    case 'esmImports': {
      const content = await reader.read(c.file);
      if (content === null) {
        return { ok: false, detail: `${c.file} not found (needed for the ESM-import check)` };
      }
      const r = esmImports(content, c.file);
      return { ok: r.ok, detail: r.detail };
    }
    case 'sourceParses': {
      const content = await reader.read(c.file);
      if (content === null) {
        return { ok: false, detail: `${c.file} not found (needed for the source-parse check)` };
      }
      if (/\.html?$/i.test(c.file)) {
        const v = validateScriptSyntax(extractInlineScripts(content));
        if (v.totalBytes === 0 || v.allParse) return { ok: true, detail: `${c.file} parses` };
        return {
          ok: false,
          detail: `${c.file}: inline JavaScript does not parse (${v.firstError ?? 'syntax error'}).`,
          ...(v.firstError ? { evidence: { firstError: v.firstError } } : {}),
        };
      }
      const out = ts.transpileModule(content, {
        reportDiagnostics: true,
        fileName: c.file,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      });
      const first = (out.diagnostics ?? []).find((d) => d.category === ts.DiagnosticCategory.Error);
      if (!first) return { ok: true, detail: `${c.file} parses` };
      let at = '';
      if (first.file && first.start !== undefined) {
        const pos = first.file.getLineAndCharacterOfPosition(first.start);
        at = ` at line ${pos.line + 1}:${pos.character + 1}`;
      }
      const message = ts.flattenDiagnosticMessageText(first.messageText, ' ');
      return {
        ok: false,
        detail: `${c.file} does not parse: ${message}${at} — the file will not load until this is fixed (commonly a truncated file or an unbalanced brace).`,
        evidence: { diagnostic: `${message}${at}` },
      };
    }
    case 'tableShape': {
      const content = await reader.read(c.file);
      if (content === null) {
        return { ok: false, detail: `${c.file} not found (needed for the table-shape check)` };
      }
      const r = tableShape(content, {
        ...(c.requiredColumns ? { requiredColumns: c.requiredColumns } : {}),
        ...(c.minRows !== undefined ? { minRows: c.minRows } : {}),
      });
      return {
        ok: r.ok,
        detail: r.ok ? r.detail : `${c.file}: ${r.detail}`,
        evidence: shapeEvidence(r),
      };
    }
    case 'recordSchema': {
      const content = await reader.read(c.file);
      const r = recordSchema(content, {
        fields: c.fields,
        ...(c.minRows !== undefined ? { minRows: c.minRows } : {}),
        ...(c.uniqueBy ? { uniqueBy: c.uniqueBy } : {}),
        ...(c.format ? { format: c.format } : {}),
        ...(c.allowExtraFields !== undefined ? { allowExtraFields: c.allowExtraFields } : {}),
      });
      const rowCount = (r as { rowCount?: number }).rowCount;
      return {
        ok: r.ok,
        detail: r.ok ? r.detail : `${c.file}: ${r.detail}`,
        ...(rowCount !== undefined ? { evidence: { rowCount } } : {}),
      };
    }
    case 'nodeRuns': {
      if (!deps?.sandboxExec) {
        return {
          ok: false,
          detail: `${c.file}: execution check unavailable in this context — the nodeRuns gate needs the sandbox executor (fail-closed).`,
        };
      }
      const timeoutMs = Math.min(c.timeoutMs ?? NODE_RUNS_DEFAULT_TIMEOUT_MS, 60_000);
      const r = await deps.sandboxExec(c.file, timeoutMs);
      const evidence = {
        exitCode: r.exitCode,
        stderrTail: r.stderrTail.slice(-2000),
        timedOut: r.timedOut,
        ...(r.denied !== undefined ? { denied: r.denied } : {}),
      };
      if (r.denied) return { ok: false, detail: `${c.file}: ${r.stderrTail}`, evidence };
      if (r.timedOut) {
        return {
          ok: false,
          detail: `${c.file} did not finish within ${timeoutMs}ms when executed — it must run to completion and exit 0.`,
          evidence,
        };
      }
      if (r.exitCode !== 0) {
        if (/ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/.test(r.stderrTail)) {
          return {
            ok: false,
            detail: `${c.file} failed to run: a module import could not be resolved. This gate can only execute dependency-free files (node built-ins are fine) — inline the dependency or remove the nodeRuns check.\n${r.stderrTail}`,
            evidence,
          };
        }
        // Name the mistake when the output shape reveals it (wrapper
        // object where an array was expected — the perf-budget lesson).
        const hint = wrapperReturnHint(r.stderrTail.split('\n'));
        return {
          ok: false,
          detail: `${c.file} exited with code ${r.exitCode} when executed — fix the failure:\n${r.stderrTail}${hint ? `\n${hint}` : ''}`,
          evidence,
        };
      }
      return { ok: true, detail: `${c.file} ran clean (exit 0)`, evidence };
    }
    case 'citationsResolve': {
      // An artifact-flagged citation check must NOT probe cited paths
      // against the artifacts drawer alone: the whole point of a
      // drawer-side evidence doc (a repro note, a fix summary) is to cite
      // REAL WORKSPACE FILES, and the plain reader swap rejected every
      // honest citation as fabricated ("cites N source(s) that do not
      // exist" — about files that exist). Merge the surfaces: the report
      // itself reads artifact-first, and a cited path resolves when it
      // exists on EITHER surface. For a drafting task `ws.read` is already
      // the overlay, so drafted files count too.
      // Resolution spans BOTH surfaces in BOTH directions. The
      // artifact-flagged direction was fixed first (a drawer-side evidence
      // doc citing real workspace files). The inverse is just as honest and
      // was still failing: a WORKSPACE deliverable citing a file the same
      // recipe told it to keep in the drawer. powerpoint-deck mandates
      // exactly that — its research step says "do not write this working
      // file to the workspace" for `sources.md`, and the workspace `deck.md`
      // then cites it as provenance — so a correct run was failed for
      // "fabricated" citations naming a file it had just written. Only the
      // READ ORDER depends on the flag: whichever surface owns the report
      // is consulted first for the report's own bytes.
      const citationsReader: WorkspaceLike = {
        read: async (f) =>
          usesArtifact
            ? ((await artifactReader.read(f)) ?? (await ws.read(f)))
            : ((await ws.read(f)) ?? (await artifactReader.read(f))),
        list: async () => [...(await ws.list()), ...(await artifactReader.list())],
      };
      const r = await citationsResolve(citationsReader, c.file, {
        ...(c.pattern ? { pattern: c.pattern } : {}),
        ...(c.flags ? { flags: c.flags } : {}),
        ...(c.minCitations !== undefined ? { minCitations: c.minCitations } : {}),
        ...(c.corpus ? { corpus: c.corpus } : {}),
        ...(deps?.knownCitationPaths ? { knownPaths: deps.knownCitationPaths } : {}),
      });
      return {
        ok: r.ok,
        detail: r.detail,
        evidence: {
          resolved: capList(r.resolved),
          unresolved: capList(r.unresolved),
          urls: capList(r.urls),
          ...(r.forgiven && r.forgiven.length > 0 ? { forgiven: capList(r.forgiven) } : {}),
        },
      };
    }
    case 'researchEvidence': {
      const exactSourceRequired = Boolean(c.sourcePath?.trim());
      const missingExternalAllowed = c.externalOptional === true && !exactSourceRequired;
      if (!deps?.researchEvidence) {
        if (missingExternalAllowed) {
          return {
            ok: true,
            detail:
              'External research evidence is unavailable in this runtime; continuing because this topic-only step makes external acquisition optional.',
          };
        }
        return {
          ok: false,
          detail:
            'Research evidence is unavailable in this runtime, so successful source acquisition cannot be verified (fail-closed).',
        };
      }
      const minSuccessful = c.minSuccessful ?? 1;
      const result = await deps.researchEvidence({
        ...(c.sourcePath !== undefined ? { sourcePath: c.sourcePath } : {}),
        tools: c.tools,
        minSuccessful,
      });
      if (!result.observable) {
        if (missingExternalAllowed) {
          return {
            ok: true,
            detail:
              'Research tool-call telemetry is unavailable; continuing because this topic-only step makes external acquisition optional.',
          };
        }
        return {
          ok: false,
          detail:
            'Research tool-call telemetry is unavailable for this step, so source acquisition cannot be verified (fail-closed).',
        };
      }
      const evidence = { matches: result.matches.slice(0, EVIDENCE_LIST_CAP) };
      if (result.matches.length < minSuccessful) {
        if (missingExternalAllowed) {
          return {
            ok: true,
            detail:
              'No successful external source acquisition was observed; continuing because this topic-only step makes external research optional.',
            evidence,
          };
        }
        const local = c.sourcePath?.trim();
        const requirement = local
          ? `successfully read the exact source file ${local} or use one of: ${c.tools.join(', ')}`
          : `successfully use at least one source tool: ${c.tools.join(', ')}`;
        return {
          ok: false,
          detail: `No verifiable source acquisition ran during this step. ${requirement}; then cite the retrieved source in the deliverable.`,
          evidence,
        };
      }
      return {
        ok: true,
        detail: `Research evidence: ${result.matches.length} successful source-acquisition call(s) observed`,
        evidence,
      };
    }
    case 'commandEvidence': {
      const script = c.script?.trim();
      const bin = c.bin?.trim();
      if ((script && bin) || (!script && !bin)) {
        return {
          ok: false,
          detail:
            'commandEvidence check is misconfigured: set exactly one of `script` (a package.json script name) or `bin` (an npx binary).',
        };
      }
      const scope = script ? ('script' as const) : ('npx' as const);
      const name = (script ?? bin)!;
      const args = c.args ?? [];
      const argSuffix = args.length > 0 ? ` ${args.join(' ')}` : '';
      const verb =
        scope === 'script' ? `\`npm run ${name}${argSuffix}\`` : `\`npx ${name}${argSuffix}\``;
      const runTool = scope === 'script' ? 'run_package_script' : 'run_npx';
      if (!deps?.commandEvidence) {
        return {
          ok: false,
          detail: `Command evidence is unavailable in this runtime, so a real ${verb} run cannot be verified (fail-closed).`,
        };
      }
      const minRuns = c.minRuns ?? 1;
      const result = await deps.commandEvidence({ scope, name, args, minRuns });
      if (!result.observable) {
        return {
          ok: false,
          detail: `Command-run telemetry is unavailable for this step, so a real ${verb} run cannot be verified (fail-closed).`,
        };
      }
      // Drafting task: the command would run against the UNMODIFIED tree, so
      // a receipt cannot verify the proposed change. Default policy is an
      // honest deferral; `onDraft: 'require'` opts a book out of drafting
      // viability instead.
      if (result.drafting && c.onDraft !== 'require') {
        return {
          ok: true,
          detail: `Execution deferred: this task drafts a change proposal, and ${verb} runs against the unmodified project — it cannot verify the proposed change. Verification happens when the proposal is applied; state plainly in your notes what remains unverified.`,
          evidence: { commandEvidence: { deferred: true } },
        };
      }
      const evidence = {
        commandEvidence: {
          runs: result.runs.slice(0, EVIDENCE_LIST_CAP).map((r) => ({
            exitCode: r.exitCode,
            timedOut: r.timedOut,
            ...(r.at ? { at: r.at } : {}),
          })),
        },
      };
      if (result.runs.length < minRuns) {
        const need =
          minRuns === 1
            ? `Run ${verb} with \`${runTool}\``
            : `Run ${verb} with \`${runTool}\` at least ${minRuns} times`;
        const outcome =
          c.expect === 'fail'
            ? 'and let it FAIL — the reproduction must demonstrate the problem before you advance'
            : 'and get it passing before you advance';
        return {
          ok: false,
          detail: `${result.runs.length === 0 ? `No ${verb} run was observed during this step` : `Only ${result.runs.length} ${verb} run(s) were observed during this step (need ${minRuns})`}. ${need} ${outcome}. If the command is awaiting user approval, say so and pause rather than retrying.`,
          evidence,
        };
      }
      // The latest `minRuns` receipts must ALL match `expect` — which is
      // what makes "N consecutive green runs" expressible for flaky-test
      // work, and means a repro that stopped failing no longer counts.
      const judged = result.runs.slice(0, minRuns);
      const timedOut = judged.find((r) => r.timedOut);
      if (timedOut) {
        return {
          ok: false,
          detail: `${verb} timed out — a timed-out run proves neither failure nor success. Re-run it to completion (raise timeoutMs if the suite is genuinely slow).`,
          evidence,
        };
      }
      const wantFail = c.expect === 'fail';
      const offending = judged.find((r) => (r.exitCode === 0) === wantFail);
      if (offending) {
        if (wantFail) {
          return {
            ok: false,
            detail: `${verb} PASSED (exit 0), but this step requires it to FAIL: a reproduction that passes does not demonstrate the problem (or the problem is already fixed — say so instead of advancing). Make the test fail for the right reason against the current code, and record the failing output.`,
            evidence,
          };
        }
        const tail = offending.stderrTail?.trim() || offending.stdoutTail?.trim() || '';
        return {
          ok: false,
          detail: `${verb} FAILED (exit ${offending.exitCode}), but this step requires it to pass.${tail ? ` Latest output tail:\n${tail}` : ''}`,
          evidence,
        };
      }
      return {
        ok: true,
        detail: `Command evidence: ${verb} ${wantFail ? 'failed as required' : 'passed'} (${judged.length} verified run(s) this step)`,
        evidence,
      };
    }
    case 'corpusBatches': {
      const published = await reader.read(c.file);
      if (published === null) {
        return {
          ok: false,
          detail: `${c.file} not found — publish the fanout batch array before advancing.`,
        };
      }
      if (!ws.listArtifacts || !ws.readArtifact) {
        return {
          ok: false,
          detail: `${c.file}: batch completeness cannot be verified because artifact reads are unavailable (fail-closed).`,
        };
      }
      const suffix = c.manifestSuffix ?? '-files.json';
      const itemsField = c.itemsField ?? 'batches';
      const totalField = c.totalField ?? 'totalFiles';
      const corpusDir = c.corpusDir
        .replace(/\\/g, '/')
        .replace(/^\.?\/+/, '')
        .replace(/^artifacts\/+/, '')
        .replace(/\/+$/, '');
      const manifests = (await ws.listArtifacts())
        .map((path) => path.replace(/\\/g, '/'))
        .filter((path) => path.startsWith(`${corpusDir}/`) && path.endsWith(suffix))
        .sort();
      if (manifests.length !== 1) {
        return {
          ok: false,
          detail:
            manifests.length === 0
              ? `${c.file}: no '*${suffix}' manifest under artifacts/${corpusDir} — the corpus is missing, so the published batches cannot be verified (fail-closed).`
              : `${c.file}: ${manifests.length} '*${suffix}' manifests under artifacts/${corpusDir} (${manifests.slice(0, 4).join(', ')}) — cannot tell which one the batches should match (fail-closed).`,
        };
      }
      const manifestPath = manifests[0]!;
      const manifestRaw = await ws.readArtifact(manifestPath);
      if (manifestRaw === null) {
        return {
          ok: false,
          detail: `${c.file}: could not read the corpus manifest artifacts/${manifestPath} (fail-closed).`,
        };
      }
      let expectedBatches: unknown;
      let expectedTotal: unknown;
      try {
        const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
        expectedBatches = manifest?.[itemsField];
        expectedTotal = manifest?.[totalField];
      } catch (error) {
        return {
          ok: false,
          detail: `${c.file}: corpus manifest artifacts/${manifestPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)} (fail-closed).`,
        };
      }
      if (!Array.isArray(expectedBatches) || expectedBatches.length === 0) {
        return {
          ok: false,
          detail: `${c.file}: corpus manifest artifacts/${manifestPath} has no non-empty '${itemsField}' array to compare against (fail-closed).`,
        };
      }
      let actual: unknown;
      try {
        actual = JSON.parse(published);
      } catch (error) {
        return {
          ok: false,
          detail: `${c.file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (!Array.isArray(actual)) {
        return {
          ok: false,
          detail: `${c.file} must BE a JSON array of batch entries, with no wrapper object.`,
        };
      }
      // Count first: this is the truncation signal a json-valid check misses,
      // and naming it plainly is what tells the assignee the file is short
      // rather than malformed.
      if (actual.length !== expectedBatches.length) {
        return {
          ok: false,
          detail: `${c.file} holds ${actual.length} batch(es) but artifacts/${manifestPath} defines ${expectedBatches.length}. Every batch must be published — a missing entry is work nobody is assigned. If the whole array will not fit in one call, say so instead of publishing a partial file.`,
        };
      }
      const batchPaths = (value: unknown): string[] | null => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
        const paths = (value as Record<string, unknown>).paths;
        if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string')) return null;
        return paths as string[];
      };
      const seen = new Set<string>();
      for (let index = 0; index < expectedBatches.length; index += 1) {
        const want = expectedBatches[index];
        const got = actual[index];
        const wantPaths = batchPaths(want);
        const gotPaths = batchPaths(got);
        const label = `batch at position ${index + 1}`;
        if (wantPaths === null) {
          return {
            ok: false,
            detail: `${c.file}: corpus manifest ${label} carries no path array (fail-closed).`,
          };
        }
        if (gotPaths === null) {
          return {
            ok: false,
            detail: `${c.file}: ${label} is not an object with a \`paths\` array of strings.`,
          };
        }
        const wantFields = want as Record<string, unknown>;
        const gotFields = got as Record<string, unknown>;
        const wantNumber = wantFields.batchNumber ?? wantFields.number;
        if (gotFields.batchNumber !== wantNumber) {
          return {
            ok: false,
            detail: `${c.file}: ${label} has batchNumber ${JSON.stringify(gotFields.batchNumber ?? null)}, expected ${JSON.stringify(wantNumber ?? null)}. The fanout addresses children by this value.`,
          };
        }
        for (const field of ['start', 'end'] as const) {
          if (gotFields[field] !== wantFields[field]) {
            return {
              ok: false,
              detail: `${c.file}: ${label} has ${field}=${JSON.stringify(gotFields[field] ?? null)}, expected ${JSON.stringify(wantFields[field] ?? null)}.`,
            };
          }
        }
        if (gotPaths.length !== wantPaths.length) {
          return {
            ok: false,
            detail: `${c.file}: ${label} carries ${gotPaths.length} path(s), expected ${wantPaths.length}.`,
          };
        }
        for (let p = 0; p < wantPaths.length; p += 1) {
          if (gotPaths[p] !== wantPaths[p]) {
            // Order matters as much as membership: a reordered batch still
            // "contains" the path, but the per-batch coverage gates key off
            // the published slice, so a retyped path becomes a gate no
            // reviewer can pass.
            return {
              ok: false,
              detail: `${c.file}: ${label} path ${p + 1} is ${JSON.stringify(gotPaths[p] ?? null)} but the manifest says ${JSON.stringify(wantPaths[p])}. Copy paths verbatim from the manifest — never retype, abbreviate, or reorder them.`,
            };
          }
        }
        for (const path of gotPaths) {
          if (seen.has(path)) {
            return {
              ok: false,
              detail: `${c.file}: '${path}' appears in more than one batch; every path must land in exactly one.`,
            };
          }
          seen.add(path);
        }
      }
      if (typeof expectedTotal === 'number' && seen.size !== expectedTotal) {
        return {
          ok: false,
          detail: `${c.file}: batches cover ${seen.size} distinct path(s) but artifacts/${manifestPath} declares ${totalField}=${expectedTotal}.`,
        };
      }
      return {
        ok: true,
        detail: `Fanout batches complete: ${actual.length} batch(es), ${seen.size} path(s), matching artifacts/${manifestPath}`,
      };
    }
    case 'corpusCoverage': {
      // The ledger honors `artifact` like every other check; the corpus
      // records it is compared against are always in the drawer, since
      // that is the only place a connector mirror writes.
      const ledger = await reader.read(c.file);
      if (ledger === null) {
        return {
          ok: false,
          detail: `${c.file} not found — write the PR coverage ledger before advancing.`,
        };
      }
      if (!ws.listArtifacts || !ws.readArtifact) {
        return {
          ok: false,
          detail: `${c.file}: connector-corpus coverage cannot be verified because artifact reads are unavailable (fail-closed).`,
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(ledger);
      } catch (error) {
        return {
          ok: false,
          detail: `${c.file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const field = c.reviewedField ?? 'reviewedFiles';
      const reviewedRaw =
        parsed && typeof parsed === 'object'
          ? (parsed as Record<string, unknown>)[field]
          : undefined;
      if (!Array.isArray(reviewedRaw) || reviewedRaw.some((value) => typeof value !== 'string')) {
        return {
          ok: false,
          detail: `${c.file}: ${field} must be an array of exact changed-path strings.`,
        };
      }
      const recordField = c.recordField ?? 'reviewedRecords';
      const reviewedRecordsRaw =
        parsed && typeof parsed === 'object'
          ? (parsed as Record<string, unknown>)[recordField]
          : undefined;
      if (
        !Array.isArray(reviewedRecordsRaw) ||
        reviewedRecordsRaw.some((value) => typeof value !== 'string')
      ) {
        return {
          ok: false,
          detail: `${c.file}: ${recordField} must be an array of exact artifact-record paths.`,
        };
      }

      const corpusDir = c.corpusDir
        .replace(/\\/g, '/')
        .replace(/^\.?\/+/, '')
        .replace(/^artifacts\/+/, '')
        .replace(/\/+$/, '');
      const filePrefix = `${corpusDir}/files/`;
      const records = (await ws.listArtifacts()).filter(
        (path) =>
          path.replace(/\\/g, '/').startsWith(filePrefix) &&
          path.endsWith('.md') &&
          !path.split('/').pop()?.startsWith('_'),
      );
      if (records.length === 0) {
        return {
          ok: false,
          detail: `${c.file}: no changed-file records were found under artifacts/${filePrefix} — the PR corpus is missing or incomplete.`,
        };
      }
      // Fanout slice, when the check carries one. Parsed before any record
      // is read so a mis-scoped child fails on its own configuration
      // rather than on a corpus it was never given.
      let slice: Set<string> | undefined;
      if (c.expectPaths !== undefined) {
        let parsedSlice: unknown;
        try {
          parsedSlice = JSON.parse(c.expectPaths);
        } catch {
          return {
            ok: false,
            detail: `${c.file}: expectPaths is not valid JSON (${c.expectPaths.slice(0, 80)}) — the batch slice never reached this gate, so its coverage cannot be scoped (fail-closed).`,
          };
        }
        if (
          !Array.isArray(parsedSlice) ||
          parsedSlice.length === 0 ||
          parsedSlice.some((value) => typeof value !== 'string' || value.trim() === '')
        ) {
          return {
            ok: false,
            detail: `${c.file}: expectPaths must be a non-empty JSON array of exact changed-path strings (fail-closed).`,
          };
        }
        slice = new Set((parsedSlice as string[]).map((path) => path.trim()));
      }

      const expected = new Set<string>();
      const scopedRecords: string[] = [];
      for (const record of records) {
        const content = await ws.readArtifact(record);
        if (content === null) {
          return {
            ok: false,
            detail: `${c.file}: could not read connector record artifacts/${record} (fail-closed).`,
          };
        }
        const path = parseFrontmatter(content).data.path?.trim();
        if (!path) {
          return {
            ok: false,
            detail: `${c.file}: connector record artifacts/${record} has no authoritative path frontmatter.`,
          };
        }
        if (slice && !slice.has(path)) continue;
        expected.add(path);
        scopedRecords.push(record);
      }
      if (slice) {
        const absent = [...slice].filter((path) => !expected.has(path)).sort();
        if (absent.length > 0) {
          return {
            ok: false,
            detail: `${c.file}: this batch names ${absent.length} path(s) with no corpus record under artifacts/${filePrefix}: ${absent.slice(0, 10).join(', ')}. The batch manifest and the mirrored corpus disagree — no assignee can reconcile that (fail-closed).`,
          };
        }
      }
      const records_ = slice ? scopedRecords : records;

      const reviewed = new Set(
        (reviewedRaw as string[]).map((path) => path.trim()).filter(Boolean),
      );
      const normalizeRecordPath = (path: string) =>
        path
          .replace(/\\/g, '/')
          .replace(/^\.?\/+/, '')
          .replace(/^artifacts\/+/, '');
      const expectedRecords = new Set(records_.map(normalizeRecordPath));
      const reviewedRecords = new Set(
        (reviewedRecordsRaw as string[])
          .map((path) => normalizeRecordPath(path.trim()))
          .filter(Boolean),
      );
      const missing = [...expected].filter((path) => !reviewed.has(path)).sort();
      const unknown = [...reviewed].filter((path) => !expected.has(path)).sort();
      const missingRecords = [...expectedRecords]
        .filter((path) => !reviewedRecords.has(path))
        .sort();
      const unknownRecords = [...reviewedRecords]
        .filter((path) => !expectedRecords.has(path))
        .sort();
      if (
        missing.length > 0 ||
        unknown.length > 0 ||
        missingRecords.length > 0 ||
        unknownRecords.length > 0
      ) {
        const parts = [
          slice
            ? `${c.file}: reviewed ${reviewed.size} path(s), but this batch covers ${expected.size}.`
            : `${c.file}: reviewed ${reviewed.size} path(s), but the connector corpus contains ${expected.size}.`,
        ];
        if (missing.length > 0) {
          parts.push(
            `Missing: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` (+${missing.length - 10} more)` : ''}.`,
          );
        }
        if (unknown.length > 0) {
          parts.push(
            slice
              ? `Outside this batch: ${unknown.slice(0, 10).join(', ')}${unknown.length > 10 ? ` (+${unknown.length - 10} more)` : ''}.`
              : `Not in PR: ${unknown.slice(0, 10).join(', ')}${unknown.length > 10 ? ` (+${unknown.length - 10} more)` : ''}.`,
          );
        }
        if (missingRecords.length > 0) {
          parts.push(
            `Unread records: ${missingRecords.slice(0, 10).join(', ')}${missingRecords.length > 10 ? ` (+${missingRecords.length - 10} more)` : ''}.`,
          );
        }
        if (unknownRecords.length > 0) {
          parts.push(
            `Unknown records: ${unknownRecords.slice(0, 10).join(', ')}${unknownRecords.length > 10 ? ` (+${unknownRecords.length - 10} more)` : ''}.`,
          );
        }
        return {
          ok: false,
          detail: parts.join(' '),
          evidence: {
            expected: expected.size,
            reviewed: reviewed.size,
            missing: capList(missing),
            unknown: capList(unknown),
            missingRecords: capList(missingRecords),
            unknownRecords: capList(unknownRecords),
          },
          // Bounded-batch craftbooks (Pull Request Review) fail this gate
          // by design once per batch. Counting what is still outstanding
          // is what separates "batch 2 of 3 landed" from a real stall —
          // without it the ladder saw one unmoved failing label, called a
          // 25→50 file jump a plateau, and told the reviewer to make "the
          // smallest change" to the coverage JSON: a directive that reads
          // as "just append the unread paths" and passes the gate with 18
          // files unreviewed.
          remaining:
            missing.length + unknown.length + missingRecords.length + unknownRecords.length,
        };
      }
      return {
        ok: true,
        detail: slice
          ? `${c.file}: coverage complete for all ${expected.size} changed path(s) in this batch and its ${expectedRecords.size} record(s).`
          : `${c.file}: coverage complete for all ${expected.size} changed path(s) and ${expectedRecords.size} per-file record(s) in artifacts/${filePrefix}.`,
        evidence: {
          expected: expected.size,
          reviewed: reviewed.size,
          expectedRecords: expectedRecords.size,
          reviewedRecords: reviewedRecords.size,
          ...(slice ? { scopedToBatch: true } : {}),
        },
      };
    }
    case 'markdownHeadingsMatch': {
      const result = await markdownHeadingsMatch(
        reader,
        c.file,
        c.outlineFile,
        c.outlineArtifact ? artifactReader : ws,
      );
      return {
        ok: result.ok,
        detail: result.detail,
        evidence: {
          outlineHeadings: capList(result.outlineHeadings),
          documentHeadings: capList(result.documentHeadings),
          ...(result.mismatchIndex !== undefined ? { mismatchIndex: result.mismatchIndex } : {}),
        },
      };
    }
    case 'valueGrounding': {
      const content = await reader.read(c.file);
      if (content === null) {
        return {
          ok: false,
          detail: `${c.file} not found — write the deliverable before advancing.`,
        };
      }
      const r = valueGrounding(
        content,
        c.facts,
        c.normalizeDigits !== undefined ? { normalizeDigits: c.normalizeDigits } : {},
      );
      return {
        ok: r.ok,
        detail: r.ok ? r.detail : `${c.file}: ${r.detail}`,
        evidence: {
          signals: capList(r.signals),
          decoysDetected: capList(r.decoysDetected),
        },
      };
    }
    case 'valuesSubsetOf': {
      const content = await reader.read(c.file);
      if (content === null) {
        return {
          ok: false,
          detail: `${c.file} not found — write the deliverable before advancing.`,
        };
      }
      // Source entries may be globs (`*`/`**`) so books can gate outputs
      // against wherever the task's input data actually lives. The output
      // file itself never counts as its own source. Over-matching only
      // WEAKENS the check (a larger allowed set), so globs are safe;
      // matching zero sources is a loud fail (misconfigured gate or the
      // inputs were deleted), never a silent pass.
      const listing = await reader.list();
      const wanted = new Set<string>();
      for (const entry of c.sourceFiles) {
        if (entry.includes('*')) {
          const re = globPathRegExp(entry);
          for (const f of listing) if (re.test(f) && f !== c.file) wanted.add(f);
        } else if (entry !== c.file) {
          wanted.add(entry);
        }
      }
      const sources: string[] = [];
      for (const f of wanted) {
        const text = await reader.read(f);
        if (text !== null) sources.push(text);
      }
      if (sources.length === 0) {
        return {
          ok: false,
          detail: `valuesSubsetOf ${c.file}: no readable source files matched ${c.sourceFiles.join(', ')} — the check needs the input data present in the workspace.`,
        };
      }
      const r = valuesSubsetOf(content, sources, {
        pattern: c.pattern,
        ...(c.flags ? { flags: c.flags } : {}),
        ...(c.minMatches !== undefined ? { minMatches: c.minMatches } : {}),
      });
      return {
        ok: r.ok,
        detail: `${c.file}: ${r.detail}`,
        evidence: { checked: r.checked, invented: capList(r.invented) },
      };
    }
    case 'planStructure': {
      const content = await reader.read(c.file);
      if (content === null) {
        return {
          ok: false,
          detail: `${c.file} not found — write the plan before advancing.`,
        };
      }
      const r = planStructure(content, {
        ...(c.minRows !== undefined ? { minRows: c.minRows } : {}),
        ...(c.ownerRoster ? { ownerRoster: c.ownerRoster } : {}),
        ...(c.requireEarlierOnly !== undefined ? { requireEarlierOnly: c.requireEarlierOnly } : {}),
        ...(c.doneWhenMinChars !== undefined ? { doneWhenMinChars: c.doneWhenMinChars } : {}),
      });
      return {
        ok: r.ok,
        detail: r.ok
          ? `${c.file}: plan table valid (${r.rows.length} rows, owners + dependencies check out)`
          : `${c.file}: ${r.detail}`,
        evidence: {
          rows: r.rows.length,
          ...(r.unknownDeps.length > 0 ? { unknownDeps: capList(r.unknownDeps) } : {}),
          ...(r.cycleIds.length > 0 ? { cycleIds: capList(r.cycleIds) } : {}),
          ...(r.weakDoneStates.length > 0 ? { weakDoneStates: capList(r.weakDoneStates) } : {}),
        },
      };
    }
    case 'judge': {
      const failOpen = (reason: string): InnerOutcome => ({
        ok: true,
        detail: `${c.file}: judge unavailable (${reason}) — approved fail-open (advisory)`,
        evidence: { judge: { verdict: 'fail-open', reason } },
      });
      if (process.env.GEZEL_DISABLE_JUDGE_GATES === '1') {
        return failOpen('disabled by GEZEL_DISABLE_JUDGE_GATES');
      }
      if (!deps?.judgeExec) return failOpen('no judge executor wired');
      const artifactText = await reader.read(c.file);
      if (artifactText === null) {
        // The mechanical floor catches missing deliverables; the judge
        // must never become a covert existence gate.
        return failOpen(`${c.file} not found`);
      }
      const sources: Array<{ path: string; text: string }> = [];
      for (const path of c.sourceFiles ?? []) {
        const text = await reader.read(path);
        if (text !== null) sources.push({ path, text });
      }
      const prompt = buildJudgePrompt({
        rubric: c.rubric,
        file: c.file,
        artifactText,
        sources,
        ...(c.requireEvidence !== undefined ? { requireEvidence: c.requireEvidence } : {}),
      });
      const timeoutMs = Math.min(c.timeoutMs ?? 60_000, 120_000);
      let raw: { text: string } | { unavailable: string };
      try {
        raw = await deps.judgeExec(prompt, timeoutMs);
      } catch (err) {
        return failOpen(err instanceof Error ? err.message : String(err));
      }
      if ('unavailable' in raw) return failOpen(raw.unavailable);
      let verdict: ReturnType<typeof parseJudgeVerdict>;
      try {
        verdict = parseJudgeVerdict(raw.text);
      } catch {
        return failOpen('unparseable judge verdict');
      }
      if (verdict.verdict === 'pass') {
        return {
          ok: true,
          detail: `${c.file}: judge pass — ${verdict.reasons[0] ?? 'meets the rubric'}`,
          evidence: { judge: { verdict: 'pass' } },
        };
      }
      const { kept } = validateJudgeEvidence(verdict, artifactText);
      if (c.requireEvidence !== false && kept.length === 0) {
        // A fail verdict whose every quote failed the verbatim wall is
        // a fabrication — it loses the verdict (fail-open).
        return failOpen('fail verdict had no verbatim evidence');
      }
      const advisory = c.advisory !== false;
      const quote = kept[0]?.replace(/\s+/g, ' ').slice(0, 200);
      const detailBody = `${c.file}: judge would reject — ${verdict.reasons[0] ?? 'rubric unmet'}${quote ? `. Evidence: "${quote}"` : ''}`;
      if (advisory) {
        return {
          ok: true,
          detail: `[advisory] ${detailBody}`,
          evidence: {
            judge: {
              verdict: 'fail',
              advisory: true,
              reasons: capList(verdict.reasons),
              quotes: capList(kept),
            },
          },
        };
      }
      return {
        ok: false,
        detail: detailBody,
        evidence: {
          judge: {
            verdict: 'fail',
            advisory: false,
            reasons: capList(verdict.reasons),
            quotes: capList(kept),
          },
        },
      };
    }
  }
}

function shapeEvidence(r: {
  ok: boolean;
  headers?: string[];
  rowCount?: number;
}): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (r.headers) out.headers = capList(r.headers);
  if (r.rowCount !== undefined) out.rowCount = r.rowCount;
  return Object.keys(out).length > 0 ? out : undefined;
}
