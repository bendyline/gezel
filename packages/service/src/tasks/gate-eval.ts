import type { GateCheck } from '@bendyline/gezel';
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
  const { ok, detail, evidence } = await evalCheckInner(c, ws, deps);
  const file = checkFile(c);
  return {
    kind: c.kind,
    ...(file !== undefined ? { file } : {}),
    label: gateCheckLabel(c),
    ok,
    detail,
    ...(evidence !== undefined ? { evidence } : {}),
  };
}

interface InnerOutcome {
  ok: boolean;
  detail: string;
  evidence?: Record<string, unknown>;
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
  const reader: WorkspaceLike = usesArtifact
    ? {
        read: ws.readArtifact ?? (async () => null),
        list: ws.listArtifacts ?? (async () => []),
        // Carry the byte reader across the artifact swap; without it a
        // `verifyImageBytes` check on an artifact deliverable would report
        // "no binary reads" even though the surface supports them.
        ...(ws.readArtifactBytes ? { readBytes: ws.readArtifactBytes.bind(ws) } : {}),
      }
    : ws;
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
        ws,
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
      const content = await ws.read(file);
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
    case 'esmImports': {
      const content = await ws.read(c.file);
      if (content === null) {
        return { ok: false, detail: `${c.file} not found (needed for the ESM-import check)` };
      }
      const r = esmImports(content, c.file);
      return { ok: r.ok, detail: r.detail };
    }
    case 'sourceParses': {
      const content = await ws.read(c.file);
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
      const r = await citationsResolve(reader, c.file, {
        ...(c.pattern ? { pattern: c.pattern } : {}),
        ...(c.flags ? { flags: c.flags } : {}),
        ...(c.minCitations !== undefined ? { minCitations: c.minCitations } : {}),
        ...(c.corpus ? { corpus: c.corpus } : {}),
      });
      return {
        ok: r.ok,
        detail: r.detail,
        evidence: {
          resolved: capList(r.resolved),
          unresolved: capList(r.unresolved),
          urls: capList(r.urls),
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
