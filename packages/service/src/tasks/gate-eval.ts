import { posix } from 'node:path';
import {
  type GateCheck,
  type GateWorkspaceReader,
  evaluateDeclarativeCheck,
  gateCheckLabel,
  isSharedGateCheck,
} from '@bendyline/gezel';

export { gateCheckLabel };
export type { GateWorkspaceReader };
import { validateFile } from '@bendyline/gezel-mcp';
import {
  type WorkspaceLike,
  buildJudgePrompt,
  citationsResolve,
  containsPattern,
  cssMinBytes,
  esmImports,
  extractInlineScripts,
  markdownHeadingsMatch,
  notContainsPattern,
  parseJudgeVerdict,
  planStructure,
  unsupportedClaims,
  validateJudgeEvidence,
  validateScriptSyntax,
  valueGrounding,
  valuesSubsetOf,
  wrapperReturnHint,
} from '@bendyline/gezel/checks';
import ts from 'typescript';
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

const PR_NON_ACTIONABLE_FINDING_RE =
  /\b(?:verified\s+ok|no\s+(?:defect|issue|finding|action\s+needed|functional\s+issue)|not\s+(?:a\s+bug|a\s+(?:functional|correctness)\s+defect|a\s+defect|introduced\s+by\s+this\s+patch|available\s+(?:in|for)\s+this\s+batch)|none\s+needed|acceptable(?:\s+as[- ]is)?|accept\s+as[- ]is|worth\s+noting|future\s+(?:optimization|hardening)|pre[- ]existing|functionally\s+harmless|intentional\s+limitation|needs?\s+(?:(?:central|cross[- ]file)\s+)?verification|requires?\s+(?:central\s+)?verification|central\s+verification|not\s+audited|implementation\s+(?:is\s+)?unknown|no\s+evidence\s+(?:of|that).{0,80}\bavailable|correct\s+(?:and\s+bounded\s+)?fallback|intent\s+is\s+correct|best[- ]effort|harmless\s+here|does\s+not\s+affect\s+runtime\s+behavior|finding\s+is\s+contingent|this\s+finding\s+is\s+contingent|risk\s+(?:is\s+)?low|may|might|could|potential(?:ly)?|possibly|likely|consider(?:ing)?|comment|documentation|documented|discoverability|verify\s+(?:that|the|whether)|verification\s+(?:of|whether)|(?:style|quoting|backslash)\s+(?:inconsistency|concern)|standardiz(?:e|ing)|if\s+.{0,160}\b(?:fails?|missing|empty|malformed|changes?|changed|removed|renamed|never|does\s+not|doesn't))\b/is;

/**
 * Models use several equivalent Markdown shapes for batch findings (plain,
 * bold, headings, bullets, and pipe-delimited rows). Normalize them before a
 * PR gate judges anchors or actionable content; matching only `B1-1:` let
 * `**B1-1** ...` and `B1-1 | ...` bypass both checks in real reviews.
 */
function prFindingBlocks(text: string): Array<{ batch: number; id: string; text: string }> {
  const lines = text.split(/\r?\n/);
  const starts: Array<{ index: number; batch: number; id: string }> = [];
  const pattern = /^\s*(?:#{1,6}\s+|[-*]\s+)?(?:\*\*)?B(\d+)-(\d+)(?:\*\*)?\b/i;
  for (let index = 0; index < lines.length; index++) {
    const match = pattern.exec(lines[index]!);
    if (!match) continue;
    starts.push({ index, batch: Number(match[1]), id: `B${match[1]}-${match[2]}` });
  }
  return starts.map((start, position) => {
    const next = starts[position + 1]?.index ?? lines.length;
    let end = next;
    for (let index = start.index + 1; index < next; index++) {
      if (/^\s*#{1,4}\s+/.test(lines[index]!)) {
        end = index;
        break;
      }
    }
    return { batch: start.batch, id: start.id, text: lines.slice(start.index, end).join('\n') };
  });
}

interface PrVerificationCandidate {
  id: string;
  path: string;
  line: number;
  severity: 'critical' | 'major' | 'minor' | 'nit';
  claim: string;
  verify: string;
}

/**
 * Pull a shard's machine-readable cross-file verification channel out of
 * its Markdown wrapper. Findings and verification candidates deliberately
 * have different contracts: a B-number is a defect the shard can already
 * prove, while a V-number is a bounded question the checkout-aware final
 * reviewer still has to resolve.
 */
function prVerificationCandidates(
  text: string,
  batch: number,
  assignedPaths: readonly string[],
): { candidates: PrVerificationCandidate[]; error?: string } {
  const heading = /^#{1,6}\s+Verification candidates\s*$/im.exec(text);
  if (!heading) {
    return {
      candidates: [],
      error:
        'add a "Verification candidates" heading with one JSON block containing {"verificationCandidates":[]}',
    };
  }
  const afterHeading = text.slice(heading.index + heading[0].length);
  const nextHeadingOffset = afterHeading.search(/^#{1,6}\s+/m);
  const section = nextHeadingOffset >= 0 ? afterHeading.slice(0, nextHeadingOffset) : afterHeading;
  const blocks = [...section.matchAll(/```json\s*([\s\S]*?)```/gi)];
  const json = blocks[0]?.[1];
  if (blocks.length !== 1 || json === undefined) {
    return {
      candidates: [],
      error:
        'the "Verification candidates" section must contain exactly one fenced JSON block with a verificationCandidates array',
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return {
      candidates: [],
      error: `verificationCandidates JSON is invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { candidates: [], error: 'verificationCandidates JSON must be an object' };
  }
  const topLevelKeys = Object.keys(value);
  if (topLevelKeys.length !== 1 || topLevelKeys[0] !== 'verificationCandidates') {
    return {
      candidates: [],
      error: 'verificationCandidates JSON must contain only the verificationCandidates key',
    };
  }
  const raw = (value as Record<string, unknown>).verificationCandidates;
  if (!Array.isArray(raw)) {
    return { candidates: [], error: 'verificationCandidates must be an array' };
  }
  if (raw.length > 12) {
    return { candidates: [], error: 'verificationCandidates must contain at most 12 entries' };
  }
  const candidates: PrVerificationCandidate[] = [];
  for (let index = 0; index < raw.length; index++) {
    const candidate = raw[index];
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return { candidates: [], error: `verificationCandidates[${index}] must be an object` };
    }
    const fields = candidate as Record<string, unknown>;
    const expectedId = `V${batch}-${index + 1}`;
    const allowedKeys = new Set(['id', 'path', 'line', 'severity', 'claim', 'verify']);
    const unknownKeys = Object.keys(fields).filter((key) => !allowedKeys.has(key));
    if (
      fields.id !== expectedId ||
      typeof fields.path !== 'string' ||
      !assignedPaths.includes(fields.path) ||
      !Number.isSafeInteger(fields.line) ||
      Number(fields.line) < 1 ||
      !['critical', 'major', 'minor', 'nit'].includes(String(fields.severity)) ||
      typeof fields.claim !== 'string' ||
      fields.claim.trim().length < 10 ||
      fields.claim.length > 400 ||
      typeof fields.verify !== 'string' ||
      fields.verify.trim().length < 3 ||
      fields.verify.length > 400 ||
      unknownKeys.length > 0
    ) {
      return {
        candidates: [],
        error: `${expectedId} must contain only id, assigned path, positive integer line, severity (critical|major|minor|nit), a concise claim, and an exact verification target`,
      };
    }
    candidates.push({
      id: fields.id,
      path: fields.path,
      line: fields.line,
      severity: fields.severity,
      claim: fields.claim.trim(),
      verify: fields.verify.trim(),
    } as PrVerificationCandidate);
  }
  return { candidates };
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
  /** Successful scoped image reads in this task, step and activation. */
  imageEvidence?: () => Promise<{ observable: boolean; paths: string[] }>;
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
  /** Service-written successful artifact read ranges for the current task step. */
  corpusReadEvidence?: () => Promise<{
    observable: boolean;
    slices: Array<{ path: string; startLine: number; endLine: number; totalLines: number }>;
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

async function completeArtifactReads(
  paths: string[],
  label: string,
  deps?: GateEvalDeps,
): Promise<InnerOutcome> {
  if (!deps?.corpusReadEvidence) {
    return { ok: false, detail: 'Artifact read history is unavailable (fail-closed).' };
  }
  const observed = await deps.corpusReadEvidence();
  if (!observed.observable) {
    return { ok: false, detail: 'Artifact read history is not observable (fail-closed).' };
  }
  const missing = paths.filter((path) => {
    const slices = observed.slices.filter((slice) => slice.path === path);
    if (slices.length === 0) return true;
    const total = slices[0]!.totalLines;
    if (
      !Number.isSafeInteger(total) ||
      total < 1 ||
      slices.some((slice) => slice.totalLines !== total)
    )
      return true;
    const ranges = slices
      .filter(
        (slice) =>
          Number.isSafeInteger(slice.startLine) &&
          Number.isSafeInteger(slice.endLine) &&
          slice.startLine >= 1 &&
          slice.endLine <= total &&
          slice.endLine >= slice.startLine,
      )
      .sort((a, b) => a.startLine - b.startLine);
    let next = 1;
    for (const range of ranges) {
      if (range.startLine > next) break;
      next = Math.max(next, range.endLine + 1);
      if (next > total) return false;
    }
    return true;
  });
  return {
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? `${label}: full artifact reads verified for all ${paths.length} records.`
        : `${label}: ${missing.length}/${paths.length} records lack full read evidence. Read every line of the exact artifact record(s), using read_artifact ranges if needed: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ' …' : ''}`,
    evidence: { expectedRecords: paths.length, missingRecords: missing.slice(0, 10) },
    remaining: missing.length,
  };
}

async function evalCheckInner(
  c: GateCheck,
  ws: GateWorkspaceReader,
  deps?: GateEvalDeps,
): Promise<InnerOutcome> {
  // The kinds every host evaluates run through the shared module; only the
  // desktop-only kinds are dispatched below.
  if (isSharedGateCheck(c)) return evaluateDeclarativeCheck(c, ws);
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
    case 'contains': {
      const r = await containsPattern(reader, c.file, c.pattern, c.flags, c.label);
      return { ok: r.ok, detail: r.detail };
    }
    case 'notContains': {
      const r = await notContainsPattern(reader, c.file, c.pattern, c.flags, c.label);
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
    case 'imageEvidence': {
      if (!deps?.imageEvidence)
        return { ok: false, detail: 'Image delivery evidence is unavailable (fail-closed).' };
      const raw = await reader.read(c.file);
      if (!raw) return { ok: false, detail: `Image manifest not found: ${c.file}` };
      let items: unknown;
      try {
        items = JSON.parse(raw)[c.imagesKey];
      } catch {
        return { ok: false, detail: `Invalid image manifest JSON: ${c.file}` };
      }
      if (
        !Array.isArray(items) ||
        items.length === 0 ||
        items.length > 100 ||
        !items.every((i) => i && typeof i.path === 'string' && i.path.trim().length > 0)
      )
        return {
          ok: false,
          detail: `${c.file}.${c.imagesKey} must list 1–100 image objects with paths.`,
        };
      const normalize = (path: string) =>
        posix.normalize(path.replaceAll('\\', '/').replace(/^workspace\//, ''));
      const expected = [...new Set(items.map((i) => normalize(posix.join(c.baseDir, i.path))))];
      const observed = await deps.imageEvidence();
      if (!observed.observable)
        return { ok: false, detail: 'Image delivery telemetry is unavailable (fail-closed).' };
      const seen = new Set(observed.paths.map(normalize));
      const missing = expected.filter((path) => !seen.has(path));
      return {
        ok: missing.length === 0,
        detail:
          missing.length === 0
            ? `All ${expected.length} manifest images were delivered to this step.`
            : `Open each missing image with read_image_as_base64 before advancing: ${missing.join(', ')}. Text, hashes and base64 printed in a shell are not image inspection.`,
        evidence: { expected, missing },
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
          detail: `${result.runs.length === 0 ? `No ${verb} run was observed during this step` : `Only ${result.runs.length} ${verb} run(s) were observed during this step (need ${minRuns})`}. ${need} ${outcome}. If the command is awaiting user approval, or \`${runTool}\` is not among your tools, say so and pause rather than retrying.`,
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
    case 'artifactReadEvidence': {
      let paths: unknown;
      try {
        paths = JSON.parse(c.paths);
      } catch {
        return { ok: false, detail: 'Artifact read paths must be a JSON array (fail-closed).' };
      }
      if (
        !Array.isArray(paths) ||
        paths.length === 0 ||
        paths.some(
          (path) =>
            typeof path !== 'string' || path.trim().length === 0 || /\{\{.*?\}\}/.test(path),
        ) ||
        new Set(paths).size !== paths.length
      ) {
        return {
          ok: false,
          detail:
            'Artifact read paths must be distinct, nonempty, resolved path strings (fail-closed).',
        };
      }
      return completeArtifactReads(paths as string[], 'Required artifacts', deps);
    }
    case 'corpusReadEvidence': {
      const raw = await reader.read(c.batchesFile);
      if (raw === null) return { ok: false, detail: `${c.batchesFile} not found (fail-closed).` };
      let batches: unknown;
      try {
        batches = JSON.parse(raw);
      } catch {
        return { ok: false, detail: `${c.batchesFile} is not valid JSON (fail-closed).` };
      }
      const number = Number(c.batchNumber);
      if (!Number.isSafeInteger(number) || number < 1 || !Array.isArray(batches)) {
        return {
          ok: false,
          detail: `${c.batchesFile}: invalid batch ${c.batchNumber} (fail-closed).`,
        };
      }
      const batch = batches.find(
        (item) =>
          item &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          (item as Record<string, unknown>).batchNumber === number,
      ) as Record<string, unknown> | undefined;
      const records = batch?.records;
      if (
        !Array.isArray(records) ||
        records.length === 0 ||
        records.some((path) => typeof path !== 'string')
      ) {
        return {
          ok: false,
          detail: `${c.batchesFile}: batch ${number} has no exact record paths (fail-closed).`,
        };
      }
      return completeArtifactReads(records as string[], `Batch ${number}`, deps);
    }
    case 'corpusBatchObservations': {
      const [batchesRaw, observations] = await Promise.all([
        reader.read(c.batchesFile),
        reader.read(c.file),
      ]);
      if (batchesRaw === null || observations === null) {
        return {
          ok: false,
          detail: `${batchesRaw === null ? c.batchesFile : c.file} not found (fail-closed).`,
        };
      }
      let batches: unknown;
      try {
        batches = JSON.parse(batchesRaw);
      } catch {
        return { ok: false, detail: `${c.batchesFile} is not valid JSON (fail-closed).` };
      }
      const number = Number(c.batchNumber);
      if (!Number.isSafeInteger(number) || number < 1 || !Array.isArray(batches)) {
        return {
          ok: false,
          detail: `${c.batchesFile}: invalid batch ${c.batchNumber} (fail-closed).`,
        };
      }
      const batch = batches.find(
        (item) =>
          item &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          (item as Record<string, unknown>).batchNumber === number,
      ) as Record<string, unknown> | undefined;
      const paths = batch?.paths;
      if (
        !Array.isArray(paths) ||
        paths.length === 0 ||
        paths.some((path) => typeof path !== 'string' || path.length === 0)
      ) {
        return {
          ok: false,
          detail: `${c.batchesFile}: batch ${number} has no assigned changed paths (fail-closed).`,
        };
      }
      const batchTitle = observations
        .split(/\r?\n/)
        .some(
          (line) =>
            /^#{1,3}\s+Batch\s+\d+\b/i.test(line) &&
            Number(/^#{1,3}\s+Batch\s+(\d+)\b/i.exec(line)?.[1]) === number,
        );
      const headings = observations
        .split(/\r?\n/)
        .filter((line) => /^\s*#{1,6}\s+/.test(line))
        .map((line) => line.replace(/^\s*#{1,6}\s+/, '').replace(/`/g, ''));
      const missing = (paths as string[]).filter(
        (path) =>
          !headings.some(
            (heading) =>
              heading === path ||
              heading.startsWith(`${path} `) ||
              heading.startsWith(`${path} —`) ||
              heading.startsWith(`${path} -`),
          ),
      );
      const findingBlocks = prFindingBlocks(observations);
      const invalidFindings = findingBlocks.filter((finding) => {
        if (finding.batch !== number) return true;
        return !(paths as string[]).some((path) => {
          const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return new RegExp(`${escaped}:\\d+\\b`).test(finding.text);
        });
      });
      const nonActionableFindings = findingBlocks.filter((finding) =>
        PR_NON_ACTIONABLE_FINDING_RE.test(finding.text),
      );
      const verification = c.requireVerificationCandidates
        ? prVerificationCandidates(observations, number, paths as string[])
        : { candidates: [] };
      const literalAnchorPlaceholders = observations
        .split(/\r?\n/)
        .filter((line) =>
          /(?:\bnew-side-line\b|:\s*(?:new\s+side\s+line|(?:new\s+)?line)\b(?!\s*\d))/i.test(line),
        );
      const invalidCount =
        invalidFindings.length +
        nonActionableFindings.length +
        literalAnchorPlaceholders.length +
        (verification.error ? 1 : 0);
      return {
        ok: batchTitle && missing.length === 0 && invalidCount === 0,
        detail: !batchTitle
          ? `${c.file}: add a Batch ${number} Markdown heading (#, ##, or ###).`
          : missing.length > 0
            ? `${c.file}: ${missing.length}/${paths.length} assigned path(s) lack their own Markdown heading: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}`
            : verification.error
              ? `${c.file}: ${verification.error}. Use V${number}-1 onward only for cross-file questions; keep proven defects as B${number}-N findings.`
              : invalidCount > 0
                ? `${c.file}: every B${number}-N finding must be an actionable PR defect and cite an assigned path with an actual integer new-side line (for example src/a.ts:42). Drop numbered non-issues (such as "no defect", "no action needed", or "acceptable as-is"), replace literal placeholders, and move checks/limitations outside Findings. Invalid: ${[
                    ...invalidFindings.map((finding) => finding.text),
                    ...nonActionableFindings.map((finding) => finding.text),
                    ...literalAnchorPlaceholders,
                  ]
                    .slice(0, 3)
                    .join(' | ')}`
                : `Batch ${number}: observations include headings for all ${paths.length} assigned path(s) and concrete anchors for every numbered finding.`,
        remaining: missing.length + invalidCount + (batchTitle ? 0 : 1),
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
      // The checked output may live in the artifacts drawer while its source
      // corpus remains in the workspace (an interview report grounded in a
      // seeded transcript is the common case). Keep the output read scoped by
      // `artifact`, but resolve source files across both project surfaces.
      // Prefer the workspace when the same source path exists on both: source
      // fixtures and shipped project data live there by default.
      const listing = usesArtifact
        ? [...new Set([...(await ws.list()), ...(await artifactReader.list())])]
        : await reader.list();
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
        const text = usesArtifact
          ? ((await ws.read(f)) ?? (await artifactReader.read(f)))
          : await reader.read(f);
        if (text !== null) sources.push(text);
      }
      if (sources.length === 0) {
        return {
          ok: false,
          detail: `valuesSubsetOf ${c.file}: no readable source files matched ${c.sourceFiles.join(', ')} — the check needs the input data present in the project.`,
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
