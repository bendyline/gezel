#!/usr/bin/env -S npx tsx
/**
 * `pnpm --filter @bendyline/gezel-evals exec tsx src/bin/score-trial.ts <runDir>`
 *
 * Walks a trial run directory and emits a structured JSON fact set to stdout.
 * Designed to be consumed by the `/eval-run` Claude Code skill (or any other
 * tool that wants to reason about a trial's outcome without re-implementing
 * the artifact-parsing logic).
 *
 * What this is and isn't:
 *   - This is the "observable facts" layer. It extracts what's on disk into a
 *     stable shape — outcome, timing, team roster, tool calls, file timeline,
 *     sniff progression, auto-answer interventions. It does NOT score.
 *   - The 0-10 rubric lives in the skill (.agents/skills/eval-run/SKILL.md). The
 *     skill applies the rubric to *these* facts so the score is auditable.
 *     Keep this script policy-free.
 *
 * Why a single JSON dump rather than a library + per-axis scripts:
 *   - The skill is a single Claude turn that does one Bash call and then
 *     reasons over the result. Multiple small calls would cost token budget
 *     and prevent cross-axis correlation.
 *   - Stable schema means the skill's prompt can describe what to expect
 *     verbatim — Claude doesn't have to discover the shape every run.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type CraftbookDroveSummary, summarizeCraftbookDrove } from '../craftbook-drove.ts';
import { summarizeKeurmeesterCasesSync } from '../keurmeester-metrics.ts';
import type { NativeEngineIncidentSummary, TrialFinalSniff } from '../types.ts';

export interface TrialFacts {
  trialId: string;
  scenarioId: string;
  modelId: string;
  /** Capability tier of the model (Theme E / E1-B); copied from result.json. */
  modelTier?: string;
  runDir: string;

  /** Optional: present when host.json was written (Tier 5a). */
  host?: unknown;
  /** Optional: present when metrics.json was written (Tier 5a). */
  perf?: unknown;
  /** Optional: present when llm-judge.json was written (Tier 2.B). Advisory only. */
  judge?: unknown;
  /** Optional: supervisor-arm trials — Keurmeester consult summary from
   *  the harvested case records under `<runDir>/keurmeester/`. */
  keurmeester?: import('../keurmeester-metrics.ts').KeurmeesterTrialSummary;
  /** Unexpected native-engine exits observed during the trial, including
   * crashes recovered by an automatic restart before the trial completed. */
  nativeEngineIncidents?: NativeEngineIncidentSummary;
  /**
   * `craftbook-*` trials only: whether the book under test actually drove the
   * task, or the trial only graded a freehand deliverable. See
   * {@link summarizeCraftbookDrove} — a PASS with `verdict: 'artifact-only'`
   * says the model produced the artifact, not that the recipe works.
   */
  craftbook?: CraftbookDroveSummary;

  outcome: {
    success: boolean;
    failureMode?: string;
    reason: string;
    durationMs: number;
    timeoutMs?: number;
    /** Wall-clock fraction of the timeout consumed (1.0 = hit timeout). */
    budgetUsedFraction: number;
  };

  timing: {
    startedAt: string;
    finishedAt: string;
    /** Wall-clock ms from trial start to the first write_file/write_artifact event we observed. */
    timeToFirstArtifactMs: number | null;
    /** ms from start to the latest file-write event. */
    timeToLastArtifactWriteMs: number | null;
    /**
     * Wall-clock ms from trial start to the FIRST generated token (product
     * latency: "how long before the model starts responding"). Parsed from
     * the daemon log's first `TTFT <n>ms` line timestamp; null when no local
     * engine log was captured (cloud/CLI providers). Theme F, F4.1.
     */
    timeToFirstTokenMs: number | null;
    /**
     * The FIRST turn's own engine first-token latency — the `<n>ms` value on
     * that same `TTFT` line (prefill → first token, queue-independent). null
     * when unavailable. Distinct from {@link timeToFirstTokenMs}, which
     * includes daemon boot + queueing before that turn began.
     */
    firstTurnTtftMs: number | null;
    /**
     * Wall-clock ms from trial start to the FIRST tool call (when the agent
     * first ACTS, vs. just talks). From the session transcript / project
     * history tool-call timestamps; null when no tool ever fired. Theme F, F4.1.
     */
    timeToFirstToolCallMs: number | null;
  };

  team: {
    totalGezelsCreated: number;
    /** Distinct roles created during the trial — order-of-first-appearance. */
    rolesCreated: string[];
    /** Roles the scenario *would have expected* but we didn't see. Empty when the scenario has no expected-role hints. */
    missingExpectedRoles: string[];
  };

  toolUse: {
    totalToolCalls: number;
    /** Aggregate counts keyed by tool name. */
    byTool: Record<string, number>;
    /** Subset of calls that triggered a red-flag pattern (see RED_FLAGS below). */
    redFlags: Array<{
      gezel: string;
      tool: string;
      argsSummary: string;
      atTurn: number;
      pattern: string;
      explanation: string;
    }>;
  };

  artifacts: {
    /** HTML files produced anywhere in the project tree (workspace/ or artifacts/). */
    htmlFiles: Array<{
      path: string;
      finalBytes: number;
      /** File-growth timeline derived from scenario log lines. May be empty for unobserved files. */
      growth: Array<{ atMs: number; bytes: number }>;
    }>;
    /**
     * Image files (.png/.jpg/.webp/.svg) anywhere in the tree. `real`
     * carries the scenario's OWN image-gate verdict (the `(real)` /
     * `(too small)` marker it logged) when the file matched a gate line —
     * the success signal for image-gate scenarios (`tool-routing-image`,
     * `petshop`) that have no HTML sniff. Omitted when no gate line
     * referenced the file (e.g. an incidental image the gate never graded).
     */
    imageFiles: Array<{ path: string; bytes: number; real?: boolean }>;
    /** Other notable files (json/md/etc.) — counted only, not enumerated, to keep the report tight. */
    otherFileCount: number;
  };

  sniff: {
    /** Sniff progression as observed in the trial log — one entry per *distinct* state thanks to logChanged. */
    progression: Array<{
      atMs: number;
      filePath: string;
      bytes: number;
      score: number;
      /** Denominator of the gate's `score=N/M` (its max), when the gate reports one. */
      scoreMax: number | null;
      signals: string[];
      failReason: string | null;
    }>;
    /** Latest state — same shape, broken out for convenience. Null when no sniff line ever ran. */
    latest: {
      filePath: string;
      bytes: number;
      score: number;
      scoreMax: number | null;
      signals: string[];
      failReason: string | null;
      /**
       * Terminal runtime-assertion counts. These keys are optional so facts
       * written before runtime reporting was added remain structurally valid.
       * When a runtime attempt was observed but its counters were unavailable
       * (for example, Chromium failed to bootstrap), both values are `null` —
       * absence of evidence must not be presented as a zero-failure pass.
       */
      runtimePassed?: number | null;
      runtimeFailed?: number | null;
    } | null;
  };

  autoAnswer: {
    total: number;
    byKind: { structured: number; inline: number };
    events: Array<{
      atMs: number;
      kind: 'structured' | 'inline';
      gezel: string | null;
      /** For structured: the question prompt (extracted from sita's session). For inline: short snippet of the meester msg. */
      question: string | null;
      /** What we picked. For structured choice picks: the choice text. */
      chose: string;
    }>;
  };

  /** Whatever the runner logged that doesn't fit elsewhere — e.g. "[trial] daemon spawned pid=…". */
  miscEvents: string[];
}

// ── Red-flag patterns ─────────────────────────────────────────────────
// Each pattern is a heuristic that surfaces a specific behavior class
// from a tool call. Keep these tight + commented — every entry will end
// up in the skill's "negatives" section of the postmortem and a false
// positive is worse than missing a case (the skill can still call out
// behavior the patterns don't enumerate, it just won't auto-cite it).
const RED_FLAGS: Array<{
  test: (call: ToolCall) => boolean;
  pattern: string;
  explanation: string;
}> = [
  {
    // Legacy camelCase spellings kept for scoring pre-rename run dirs.
    test: (c) =>
      c.name === 'run_npx' &&
      /bin:\s*"(generate_image|render_image|write_artifact|writeFile|write_file|readFile|read_file|search_memory)"/i.test(
        c.argsSummary ?? '',
      ),
    pattern: 'mcp-tool-via-npx',
    explanation:
      "Tried to invoke an MCP tool as if it were an npm package via run_npx. The MCP tool was either missing from this gezel's toolset (role-tool-filter scope) or the gezel didn't notice it in the system prompt. Symptom of role-routing misalignment.",
  },
  {
    test: (c) =>
      c.name === 'npm_install' &&
      /(canvas|generate-image|stable-diffusion|sharp|jimp|ai-generator)/i.test(c.argsSummary ?? ''),
    pattern: 'image-pkg-install-instead-of-tool',
    explanation:
      "Tried to install an image-generation npm package instead of using the existing `generate_image` MCP tool. Typically means the gezel doesn't have `images` in its toolset group — recruit an `image-generator` role gezel for image work.",
  },
  {
    test: (c) =>
      c.name === 'write_artifact' &&
      /\.(png|jpg|jpeg|webp|svg|gif|mp4|wav|mp3)$/i.test(parsePath(c.argsSummary) ?? ''),
    pattern: 'prose-as-binary',
    explanation:
      'Wrote text content into a binary-extension artifact path (e.g. saved a prose description as `logo.png`). This is the classic fabrication pattern — gezel pretends the deliverable exists by writing the WRONG content under the right filename.',
  },
  {
    test: (c) => c.name === 'ask_user_question' && (c.argsSummary ?? '').length === 0,
    pattern: 'empty-question',
    explanation:
      "Called ask_user_question with empty args — usually a tool-schema misfire. Worth checking the gezel's context.",
  },
];

// Session-level red flags — patterns that can't be expressed as per-tool-call
// tests because they fire on the *absence* of a tool call. These run after
// the per-call loop, scanning the full message stream of each session.
//
// Currently one entry: `prose-as-deliverable`. The matrix #2 squisq incident
// was the load-bearing case — the Reviewer pasted a 5965-char
// structured review (`# Squisq Architecture and Code Review` + H2
// subheadings) into the assistant message AND emitted 9 read-only tool calls
// (list_dir / read_file) but never called `write_file`. The Meester then
// hallucinated "saved to review.md" without verifying. No per-call test
// catches "model produced a long-form deliverable but sent it down the wrong
// channel" — it's the absence of write_file that's the smoking gun.
//
// Design notes for adding more session-level red flags later:
//   - Each test takes a session's full message list + per-session tool-call
//     stream and returns an array of red-flag descriptors (zero, one, or
//     many — a single trial can fire the same pattern multiple times across
//     different sessions, e.g. both Reviewer and Voorman both prose-as-
//     deliver in the same trial).
//   - Keep the threshold conservative — the rubric weighs `redFlags` as a
//     binary "any fired → 0 on Behavior soundness" signal in the skill, so
//     a false positive is worse than missing a case.
// File-writing tool names for the time-to-artifact and prose-as-deliverable
// checks. Legacy camelCase spellings kept for scoring pre-rename run dirs.
const FILE_WRITE_TOOLS = new Set([
  'write_file',
  'write_artifact',
  'append_to_file',
  'writeFile',
  'appendToFile',
]);

const PROSE_AS_DELIVERABLE_MIN_CHARS = 800;
const PROSE_AS_DELIVERABLE_MIN_H2_COUNT = 2;

const SESSION_RED_FLAGS: Array<{
  pattern: string;
  explanation: string;
  test: (
    msgs: SessionMessage[],
    gezel: string,
  ) => Array<{
    tool: string;
    argsSummary: string;
    atTurn: number;
  }>;
}> = [
  {
    pattern: 'prose-as-deliverable',
    explanation:
      "Emitted a long-form structured deliverable (H1 + H2 sections, ≥800 chars) as the assistant's chat content WITHOUT a write_file/write_artifact/append_to_file call in the same turn. Caller will see prose in chat but no file on disk; downstream gezels reading the asker's history won't find an addressable artifact. Symptom of the consultation-mode 'reply in chat' guidance overriding the deliverable shape — fix in the role's about.md (the Researcher template's 'deliverable IS a file' rule is the pattern) and use `ensure_gezel` + `message_gezel` with `expectedDeliverable: {kind:'file'}` for file deliverables.",
    test: (msgs, _gezel) => {
      const hits: Array<{ tool: string; argsSummary: string; atTurn: number }> = [];
      msgs.forEach((msg, idx) => {
        if (msg.role !== 'assistant') return;
        const txt = typeof msg.content === 'string' ? msg.content : '';
        if (txt.length < PROSE_AS_DELIVERABLE_MIN_CHARS) return;
        // Structured-document shape: H1 at the start (or near it) plus
        // at least N H2 subheadings. A long numbered plan in chat
        // (acceptable consultation reply) won't fire; a multi-section
        // markdown report will.
        const startsWithH1 = /^[\s#]*#\s+\S/m.test(txt.slice(0, 200));
        const h2Matches = txt.match(/^##\s+\S/gim) ?? [];
        if (!startsWithH1 || h2Matches.length < PROSE_AS_DELIVERABLE_MIN_H2_COUNT) return;
        // No file-writing call in the same assistant message.
        const calls = msg.toolCalls ?? [];
        const wrote = calls.some((c) => FILE_WRITE_TOOLS.has(c.name));
        if (wrote) return;
        const preview = txt.slice(0, 120).replace(/\n/g, ' ');
        hits.push({
          tool: '(no write_file this turn)',
          argsSummary: `content_chars=${txt.length} h2_count=${h2Matches.length} preview="${preview}…"`,
          atTurn: idx,
        });
      });
      return hits;
    },
  },
];

// ── Helpers ────────────────────────────────────────────────────────────

interface ToolCall {
  name: string;
  durationMs?: number;
  success?: boolean;
  argsSummary?: string;
}

interface SessionMessage {
  role: string;
  content: unknown;
  at: string;
  toolCalls?: ToolCall[];
  from?: { gezelId?: string; gezelName?: string };
}

interface SessionFile {
  messages?: SessionMessage[];
  [k: string]: unknown;
}

interface HistoryEvent {
  at?: string;
  kind?: string;
  gezelId?: string;
  details?: {
    name?: string;
    tool?: string;
    path?: string;
    durationMs?: number;
    success?: boolean;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function readLines(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function readJsonLines<T>(path: string): T[] {
  const out: T[] = [];
  for (const line of readLines(path)) {
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // skip bad line
    }
  }
  return out;
}

function parsePath(argsSummary: string | undefined): string | null {
  if (!argsSummary) return null;
  const m = argsSummary.match(/path:\s*"([^"]+)"/);
  return m ? (m[1] ?? null) : null;
}

/**
 * Parse a scenario sniff / mission-criteria gate line:
 *   "[2026-05-15T…Z] [scenario] foo.html bytes=5845 score=7/7 signals=a,b failReason="..."
 *   "[2026-06-27T…Z] [scenario] stale-workspace-rescue notes.html bytes=6000 score=6/6 signals=…"
 *   "[2026-06-27T…Z] [scenario] craftbook-form-wizard bytes=4210 checks=8/8 failures=none"
 *
 * `signals=` identifies a signal-bearing gate line. Generic craftbook
 * adapter scenarios instead log `checks=N/M failures=…`; those lines still
 * carry an objective score, just without named signal labels. Image-asset
 * lines are parsed separately by `parseScenarioImageLine`.
 *
 * The file path is taken as the LAST bare (non `key=val`) token before
 * `bytes=`. Standard HTML-sniff lines put the path first then key=val
 * pairs (`index.html provider=x bytes=…`); custom-criteria scenarios
 * prefix it with the scenario key (`stale-workspace-rescue notes.html
 * bytes=…`). Taking the last bare token handles both — the earlier
 * `^(\S+)…` regex anchored on the first token and silently failed to
 * match the two-bare-token mission-criteria shape, which is exactly why
 * `stale-workspace-rescue` came out sniff-blind (sniff.latest = null) on
 * a clean pass.
 */
function parseSniffLogLine(line: string): {
  atIso: string;
  filePath: string;
  bytes: number;
  score: number;
  /** Denominator of `score=N/M` (the gate's max), when present. */
  scoreMax: number | null;
  signals: string[];
  failReason: string | null;
} | null {
  // Timestamp prefix.
  const tsMatch = line.match(/^\[([^\]]+)\]\s+\[scenario\]\s+(.*)$/);
  if (!tsMatch) return null;
  const atIso = tsMatch[1] ?? '';
  const body = tsMatch[2] ?? '';
  const payload = body.match(/\bbytes=(\d+)(?:\s+score=(\d+)(?:\/(\d+))?)?\s+signals=(\S+)(.*)$/);
  if (!payload) {
    const checkPayload = body.match(/\b(?:bytes=(\d+)\s+)?checks=(\d+)\/(\d+)\s+failures=(.*)$/);
    if (!checkPayload) return null;
    const prefix = body.slice(0, checkPayload.index).trim();
    const bareTokens = prefix.split(/\s+/).filter((t) => t && !t.includes('='));
    const failureText = (checkPayload[4] ?? '').trim();
    return {
      atIso,
      filePath: bareTokens[bareTokens.length - 1] ?? '',
      // A logger that omits `bytes=` lands here as 0, which reads in
      // facts.json exactly like a scenario that wrote nothing. Every
      // in-tree logger now emits the token; keep it that way rather than
      // relying on this fallback to mean anything.
      bytes: checkPayload[1] ? Number(checkPayload[1]) : 0,
      score: Number(checkPayload[2]),
      scoreMax: Number(checkPayload[3]),
      signals: [],
      failReason:
        failureText && failureText !== 'none' ? (failureText.split(' | ')[0] ?? failureText) : null,
    };
  }
  const prefix = body.slice(0, payload.index).trim();
  const bareTokens = prefix.split(/\s+/).filter((t) => t && !t.includes('='));
  const filePath = bareTokens[bareTokens.length - 1] ?? '';
  const signals = payload[4] === 'none' ? [] : (payload[4] ?? '').split(',').filter(Boolean);
  const rest = payload[5] ?? '';
  // Scenario writers interpolate the reason raw — `failReason="${reason}"` —
  // so a reason that itself quotes something ("…out-of-order at "Timeline"")
  // terminates the strict match at the inner quote and the useful half is
  // silently dropped. failReason is always the last field on the line, so fall
  // back to a greedy match through the final quote. Keeps working if a writer
  // ever starts escaping properly, and recovers reasons from existing logs.
  const failReasonMatch =
    rest.match(/\sfailReason="((?:[^"\\]|\\.)*)"\s*$/) ?? rest.match(/\sfailReason="(.*)"\s*$/s);
  return {
    atIso,
    filePath,
    bytes: Number(payload[1]),
    score: payload[2] ? Number(payload[2]) : signals.length,
    scoreMax: payload[3] ? Number(payload[3]) : null,
    signals,
    failReason: failReasonMatch ? (failReasonMatch[1] ?? '').replace(/\\"/g, '"') : null,
  };
}

interface RuntimeSniffObservation {
  atIso: string;
  key: string;
  runtimePassed: number | null;
  runtimeFailed: number | null;
}

/**
 * Parse the runtime companion line emitted after a static HTML sniff passes:
 *
 *   `[scenario] project/workspace/index.html#runtime passed=4 failed=1 ...`
 *   `[scenario] project/workspace/index.html#runtime BOOTSTRAP_FAIL "..."`
 *
 * Runtime observations deliberately stay separate from static sniff
 * progression. A runtime retry is not another capability-signal score, and
 * summing repeated `passed` / `failed` snapshots would inflate the terminal
 * counts. The latest matching observation wins below.
 */
function parseRuntimeSniffLogLine(line: string): RuntimeSniffObservation | null {
  const match = line.match(/^\[([^\]]+)\]\s+\[scenario\]\s+(.+?)#runtime\s+(.+)$/);
  if (!match) return null;

  const atIso = match[1] ?? '';
  const key = (match[2] ?? '').trim();
  const payload = match[3] ?? '';
  const counters = payload.match(/\bpassed=(\d+)\s+failed=(\d+)\b/);
  if (counters) {
    return {
      atIso,
      key,
      runtimePassed: Number(counters[1]),
      runtimeFailed: Number(counters[2]),
    };
  }

  if (/\bBOOTSTRAP_FAIL\b/.test(payload)) {
    return { atIso, key, runtimePassed: null, runtimeFailed: null };
  }
  return null;
}

function validRuntimeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * `result.json.finalSniff` is the terminal source of truth on failed trials.
 * A partially written/malformed pair is retained as `null` rather than being
 * coerced to zero, which would make unknown runtime state look successful.
 */
function runtimeCountersFromFinalSniff(
  sniff: TrialFinalSniff | undefined,
): Pick<RuntimeSniffObservation, 'runtimePassed' | 'runtimeFailed'> | null {
  if (!sniff) return null;
  const hasPassed = Object.prototype.hasOwnProperty.call(sniff, 'runtimePassed');
  const hasFailed = Object.prototype.hasOwnProperty.call(sniff, 'runtimeFailed');
  if (!hasPassed && !hasFailed) return null;
  return {
    runtimePassed: validRuntimeCount(sniff.runtimePassed) ? sniff.runtimePassed : null,
    runtimeFailed: validRuntimeCount(sniff.runtimeFailed) ? sniff.runtimeFailed : null,
  };
}

function sameSniffTarget(left: string, right: string): boolean {
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

/**
 * Parse a scenario image-asset gate line:
 *   "[2026-06-27T…Z] [scenario] image default/workspace/sunset.png bytes=447573 (real)"
 *
 * Image-gate scenarios (`tool-routing-image`, `petshop`) have no HTML
 * sniff, so without surfacing the gate's own `(real)`/`(too small)`
 * verdict the quality axis is blind to a clean image deliverable. The
 * `key` is `<projectId>/<surface>/<path>`; the walked artifact path
 * (`<surface>/<relPath>`) is a suffix of it, which is how we reconcile
 * the two in `score()`.
 */
function parseScenarioImageLine(line: string): {
  atIso: string;
  key: string;
  bytes: number;
  real: boolean;
} | null {
  const m = line.match(
    /^\[([^\]]+)\]\s+\[scenario\]\s+image\s+(\S+)\s+bytes=(\d+)\s+\((real|too small)\)/,
  );
  if (!m) return null;
  return { atIso: m[1] ?? '', key: m[2] ?? '', bytes: Number(m[3]), real: m[4] === 'real' };
}

/**
 * Parses both old + new shapes of the auto-answer log line:
 *   OLD: `[ts] [auto-answer] structured <id> (gezel/project) → choice[N] = "label"`
 *   NEW: `[ts] [auto-answer] structured <id> (gezel/project) "<prompt-preview>" → choice[N] = "label"`
 * The new Tier 2.A shape surfaces the question
 * prompt inline so the postmortem doesn't need to cross-reference
 * sessions. Older trials don't have the prompt segment; we fall back
 * to no-prompt extraction in that case.
 */
function parseAutoAnswerLogLine(line: string): {
  atIso: string;
  kind: 'structured' | 'inline';
  gezel: string | null;
  /** Inline question prompt preview, when the new log shape includes it. */
  promptInline: string | null;
  chose: string;
} | null {
  const tsMatch = line.match(/^\[([^\]]+)\]\s+\[auto-answer\]\s+(.*)$/);
  if (!tsMatch) return null;
  const atIso = tsMatch[1] ?? '';
  const body = tsMatch[2] ?? '';
  const inlineMatch = body.match(/^inline\s+(\w+)/);
  if (inlineMatch) {
    return {
      atIso,
      kind: 'inline',
      gezel: inlineMatch[1] ?? null,
      promptInline: null,
      chose: 'default',
    };
  }
  // Try new-shape (with prompt preview between `()` and `→`) first; fall back to old shape.
  const newMatch = body.match(
    /^structured\s+\S+\s+\(([^/]+)\/[^)]+\)\s+"((?:[^"\\]|\\.)*)"\s+→\s+(.*)$/,
  );
  const oldMatch = newMatch
    ? null
    : body.match(/^structured\s+\S+\s+\(([^/]+)\/[^)]+\)\s+→\s+(.*)$/);
  const match = newMatch ?? oldMatch;
  if (!match) return null;
  const gezel = match[1] ?? null;
  const promptInline = newMatch ? (newMatch[2] ?? '').replace(/\\"/g, '"') : null;
  const tail = newMatch ? (newMatch[3] ?? '') : (oldMatch?.[2] ?? '');
  const choiceMatch = tail.match(/^choice\[\d+\]\s*=\s*"((?:[^"\\]|\\.)*)"$/);
  const chose = choiceMatch ? (choiceMatch[1] ?? '').replace(/\\"/g, '"') : tail.trim();
  return { atIso, kind: 'structured', gezel, promptInline, chose };
}

function isoToMsSince(startedAt: string, iso: string): number {
  return Date.parse(iso) - Date.parse(startedAt);
}

// The llama-cpp provider logs `[llama-cpp] TTFT <n>ms (session model=…)` on
// the first content delta of every turn (provider.ts). The FIRST such line's
// leading ISO timestamp marks when the trial's first token arrived; its `<n>`
// is that turn's own prefill→first-token latency. Local-engine only — cloud /
// CLI providers write no such line, so both fields stay null there. Theme F, F4.1.
const TTFT_LINE_RE = /^(\S+)\s.*\bTTFT (\d+)ms/;
function parseFirstTokenTiming(
  daemonLog: string,
  startedAt: string,
): { timeToFirstTokenMs: number | null; firstTurnTtftMs: number | null } {
  for (const line of daemonLog.split('\n')) {
    const m = TTFT_LINE_RE.exec(line);
    if (!m) continue;
    const iso = m[1] ?? '';
    const ttftMs = Number.parseInt(m[2] ?? '', 10);
    const at = Date.parse(iso);
    return {
      timeToFirstTokenMs: Number.isNaN(at) ? null : at - Date.parse(startedAt),
      firstTurnTtftMs: Number.isNaN(ttftMs) ? null : ttftMs,
    };
  }
  return { timeToFirstTokenMs: null, firstTurnTtftMs: null };
}

function walkFiles(root: string, base = ''): Array<{ relPath: string; bytes: number }> {
  const out: Array<{ relPath: string; bytes: number }> = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of entries) {
    const abs = join(root, name);
    const relPath = base ? `${base}/${name}` : name;
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...walkFiles(abs, relPath));
    } else if (st.isFile()) {
      out.push({ relPath, bytes: st.size });
    }
  }
  return out;
}

// Scenarios where we have an opinion about which role *should* have been
// recruited. Used to populate `missingExpectedRoles`. Keep tight — a
// missing entry is fine (we just don't surface a hint); a wrong entry
// would generate false positives in the skill's report.
const SCENARIO_EXPECTED_ROLES: Record<string, string[]> = {
  petshop: ['image-generator'],
  'tool-routing-image': ['image-generator'],
  // tictactoe and tankcombat don't have a single canonical role beyond
  // developer/builder — too contested to encode here.
};

// ── Main ───────────────────────────────────────────────────────────────

export function score(runDir: string): TrialFacts {
  const result = readJson<{
    trialId: string;
    scenarioId: string;
    modelId: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    success: boolean;
    reason: string;
    failureMode?: string;
    modelTier?: string;
    finalSniff?: TrialFinalSniff;
    nativeEngineIncidents?: NativeEngineIncidentSummary;
  }>(join(runDir, 'result.json'));
  if (!result) throw new Error(`no result.json at ${runDir}`);

  // Best-effort: peel the configured budget out of the trial log's
  // `[poll] starting (...maxDuration=Nms...)` line. Without this match
  // the fraction defaults to 1, which saturates and hides real budget
  // usage for fast successes.
  const logLines = readLines(join(runDir, 'log.txt'));
  const timeoutLine = logLines.find((l) => l.includes('[poll] starting'));
  const timeoutMatch = timeoutLine?.match(/maxDuration=(\d+)ms/);
  const timeoutMs = timeoutMatch ? Number(timeoutMatch[1]) : undefined;
  const budgetUsedFraction = timeoutMs ? Math.min(result.durationMs / timeoutMs, 1) : 1;

  // Team roster from history.jsonl: which roles got created.
  const histLines = readLines(join(runDir, 'history.jsonl'));
  const projectHistoryEvents = (() => {
    const projectHistoryDir = join(runDir, 'project-history');
    let files: string[];
    try {
      files = readdirSync(projectHistoryDir).filter((name) => name.endsWith('.jsonl'));
    } catch {
      return [] as HistoryEvent[];
    }
    return files.flatMap((name) => readJsonLines<HistoryEvent>(join(projectHistoryDir, name)));
  })();
  const rolesCreated: string[] = [];
  let totalGezelsCreated = 0;
  for (const line of histLines) {
    try {
      const e = JSON.parse(line);
      if (e.kind === 'gezel.created') {
        totalGezelsCreated++;
        const role = e.details?.role ?? null;
        if (role && !rolesCreated.includes(role)) rolesCreated.push(role);
      }
    } catch {
      // skip bad line
    }
  }
  const expectedRoles = SCENARIO_EXPECTED_ROLES[result.scenarioId] ?? [];
  // Normalize role names before comparing: gezel-template display names
  // are "Title Case With Spaces" (e.g. "Image Generator") but the
  // SPECIALIST_ROLES enum + scenario expectations are "kebab-case"
  // ("image-generator"). Drop hyphens/spaces + lowercase for a stable
  // comparison. Accept descriptive role strings too ("image-generator
  // for AI-created PNG logo") so the scorer doesn't penalize correct
  // delegation just because the Meester made the job title concrete.
  const norm = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, '');
  const createdNorm = rolesCreated.map(norm);
  const missingExpectedRoles = expectedRoles.filter((r) => {
    const expected = norm(r);
    return !createdNorm.some((created) => created === expected || created.includes(expected));
  });

  // Tool calls from sessions/*.json.
  const sessionFiles = (() => {
    try {
      return readdirSync(join(runDir, 'sessions'))
        .filter((n) => n.endsWith('.json'))
        .map((n) => join(runDir, 'sessions', n));
    } catch {
      return [];
    }
  })();

  // KNOWN UNDER-COUNTING — codex-cli specifically:
  //   When codex runs with `--full-auto` / `--dangerously-bypass-approvals`,
  //   its native tool surface (file_change, shell, web_search) writes
  //   directly to disk and only surfaces via codex's NDJSON event
  //   stream → invoker.ts → session.toolCalls. If a trial ends before
  //   codex's response stream finishes (e.g. a 32-second self-correction
  //   trial where the file fix arrives, sniff passes, and the capture
  //   phase snapshots sessions BEFORE codex's session emits its final
  //   item-completed events), the session JSON dump shows zero toolCalls
  //   even though the deliverable is on disk. The fix lives upstream
  //   (drain in-flight chats before capture in runner.ts); this comment
  //   documents the symptom so the postmortem reader doesn't read
  //   `totalToolCalls: 0` as "the model did nothing."
  const byTool: Record<string, number> = {};
  const redFlags: TrialFacts['toolUse']['redFlags'] = [];
  // Track time-to-first-artifact via write_file/write_artifact calls.
  let firstArtifactAt: number | null = null;
  let lastArtifactAt: number | null = null;
  let firstToolCallAt: number | null = null;
  const noteFirstToolCall = (atMs: number): void => {
    if (firstToolCallAt === null || atMs < firstToolCallAt) firstToolCallAt = atMs;
  };
  const projectHistoryToolCounts: Record<string, number> = {};
  let projectHistoryToolCalls = 0;
  let projectHistoryFirstArtifactAt: number | null = null;
  let projectHistoryLastArtifactAt: number | null = null;
  // Map question-id → question text, for cross-referencing auto-answer events.
  // We extract from the sita-style sessions where the `ask_user_question`
  // argsSummary contains the `prompt: "..."` field.
  const askQuestionPrompts: Array<{ atIso: string; gezel: string; question: string }> = [];
  let totalToolCalls = 0;

  for (const event of projectHistoryEvents) {
    if (event.kind === 'tool.called') {
      const name = event.details?.name;
      if (name) {
        projectHistoryToolCalls++;
        projectHistoryToolCounts[name] = (projectHistoryToolCounts[name] ?? 0) + 1;
        if (event.at) noteFirstToolCall(isoToMsSince(result.startedAt, event.at));
      }
    }
    if (event.kind === 'workspace.write' && event.at && event.gezelId) {
      const atMs = isoToMsSince(result.startedAt, event.at);
      if (projectHistoryFirstArtifactAt === null || atMs < projectHistoryFirstArtifactAt) {
        projectHistoryFirstArtifactAt = atMs;
      }
      if (projectHistoryLastArtifactAt === null || atMs > projectHistoryLastArtifactAt) {
        projectHistoryLastArtifactAt = atMs;
      }
    }
  }

  for (const sessPath of sessionFiles) {
    const sess = readJson<SessionFile>(sessPath);
    if (!sess?.messages) continue;
    const gezelFromFilename = (sessPath.split('/').pop() ?? '').split('--')[0] ?? 'unknown';
    sess.messages.forEach((msg, idx) => {
      if (msg.role !== 'assistant') return;
      const calls = msg.toolCalls ?? [];
      for (const c of calls) {
        totalToolCalls++;
        byTool[c.name] = (byTool[c.name] ?? 0) + 1;
        if (msg.at) noteFirstToolCall(isoToMsSince(result.startedAt, msg.at));
        // Time-to-artifact.
        if (FILE_WRITE_TOOLS.has(c.name) && c.success !== false && msg.at) {
          const atMs = isoToMsSince(result.startedAt, msg.at);
          if (firstArtifactAt === null || atMs < firstArtifactAt) firstArtifactAt = atMs;
          if (lastArtifactAt === null || atMs > lastArtifactAt) lastArtifactAt = atMs;
        }
        // Red flags.
        for (const rf of RED_FLAGS) {
          if (rf.test(c)) {
            redFlags.push({
              gezel: gezelFromFilename,
              tool: c.name,
              argsSummary: c.argsSummary ?? '',
              atTurn: idx,
              pattern: rf.pattern,
              explanation: rf.explanation,
            });
          }
        }
        // (Session-level red flag scanning happens once per session
        // after this per-call loop completes — see SESSION_RED_FLAGS.)
        // Extract ask_user_question prompts. The argsSummary is often
        // truncated mid-string with an ellipsis (e.g. `prompt: "What is th`),
        // so we accept either a properly closed string OR a string that
        // ends at a truncation marker / end-of-line. The first match (closed
        // string) wins when available; the open form is a fallback.
        if (c.name === 'ask_user_question' && msg.at) {
          const summary = c.argsSummary ?? '';
          const closed = summary.match(/prompt:\s*"((?:[^"\\]|\\.)*)"/);
          const truncated = closed ? null : summary.match(/prompt:\s*"([^"]*)$/);
          const question = closed
            ? (closed[1] ?? '').replace(/\\"/g, '"')
            : (truncated?.[1]?.replace(/\\"/g, '"') ?? null);
          if (question) {
            askQuestionPrompts.push({
              atIso: msg.at,
              gezel: gezelFromFilename,
              question,
            });
          }
        }
      }
    });
    // Session-level red flags. These look across the message stream
    // for patterns the per-call loop can't see — most importantly
    // "model emitted a long-form deliverable as chat content without
    // a write_file in the same turn." Run once per session, not once
    // per call.
    for (const srf of SESSION_RED_FLAGS) {
      for (const hit of srf.test(sess.messages, gezelFromFilename)) {
        redFlags.push({
          gezel: gezelFromFilename,
          tool: hit.tool,
          argsSummary: hit.argsSummary,
          atTurn: hit.atTurn,
          pattern: srf.pattern,
          explanation: srf.explanation,
        });
      }
    }
  }

  if (totalToolCalls === 0 && projectHistoryToolCalls > 0) {
    totalToolCalls = projectHistoryToolCalls;
    for (const [name, count] of Object.entries(projectHistoryToolCounts)) {
      byTool[name] = count;
    }
  }
  if (firstArtifactAt === null && projectHistoryFirstArtifactAt !== null) {
    firstArtifactAt = projectHistoryFirstArtifactAt;
  }
  if (lastArtifactAt === null && projectHistoryLastArtifactAt !== null) {
    lastArtifactAt = projectHistoryLastArtifactAt;
  }

  // Sniff progression from log.txt.
  const sniffProgression: TrialFacts['sniff']['progression'] = [];
  for (const line of logLines) {
    const parsed = parseSniffLogLine(line);
    if (!parsed) continue;
    sniffProgression.push({
      atMs: isoToMsSince(result.startedAt, parsed.atIso),
      filePath: parsed.filePath,
      bytes: parsed.bytes,
      score: parsed.score,
      scoreMax: parsed.scoreMax,
      signals: parsed.signals,
      failReason: parsed.failReason,
    });
  }
  const lastSniff = sniffProgression[sniffProgression.length - 1];
  const runtimeObservations = logLines
    .map(parseRuntimeSniffLogLine)
    .filter((observation): observation is RuntimeSniffObservation => observation !== null);
  const loggedRuntime = lastSniff
    ? runtimeObservations
        .filter((observation) => sameSniffTarget(observation.key, lastSniff.filePath))
        .at(-1)
    : undefined;
  // Failed trials persist the terminal runner sniff into result.json; prefer
  // that authoritative state over a potentially earlier buffered log line.
  // Successful and historical trials may not have finalSniff, so fall back to
  // the latest matching #runtime line. These are snapshots, never totals.
  const resultRuntime =
    lastSniff && result.finalSniff && sameSniffTarget(result.finalSniff.key, lastSniff.filePath)
      ? runtimeCountersFromFinalSniff(result.finalSniff)
      : null;
  const latestRuntime =
    resultRuntime ??
    (loggedRuntime
      ? {
          runtimePassed: loggedRuntime.runtimePassed,
          runtimeFailed: loggedRuntime.runtimeFailed,
        }
      : null);

  // Auto-answer events.
  const autoAnswerEvents: TrialFacts['autoAnswer']['events'] = [];
  let structuredCount = 0;
  let inlineCount = 0;
  for (const line of logLines) {
    const aa = parseAutoAnswerLogLine(line);
    if (!aa) continue;
    if (aa.kind === 'structured') structuredCount++;
    else inlineCount++;
    // Prefer the inline prompt from the log line (Tier 2.A); fall back to
    // session-derived question matching for legacy log lines that didn't
    // include it. Last resort: null (the choice text alone is usually
    // enough context for the postmortem).
    let question: string | null = aa.promptInline;
    if (!question && aa.gezel) {
      const candidates = askQuestionPrompts.filter(
        (q) =>
          q.gezel.toLowerCase() === (aa.gezel ?? '').toLowerCase() &&
          Date.parse(q.atIso) <= Date.parse(aa.atIso),
      );
      question = candidates[candidates.length - 1]?.question ?? null;
    }
    autoAnswerEvents.push({
      atMs: isoToMsSince(result.startedAt, aa.atIso),
      kind: aa.kind,
      gezel: aa.gezel,
      question,
      chose: aa.chose,
    });
  }

  // Artifact inventory (from workspace/ + artifacts/ snapshot dirs).
  const fileEntries = [
    ...walkFiles(join(runDir, 'workspace')).map((f) => ({ ...f, surface: 'workspace' as const })),
    ...walkFiles(join(runDir, 'artifacts')).map((f) => ({ ...f, surface: 'artifacts' as const })),
  ];
  const htmlFiles = fileEntries
    .filter((f) => f.relPath.toLowerCase().endsWith('.html'))
    .map((f) => {
      const surfaceRel = `${f.surface}/${f.relPath}`;
      // Pull growth from sniff progression where filePath matches the surfaceRel suffix.
      const growth = sniffProgression
        .filter((p) => p.filePath.endsWith(surfaceRel) || surfaceRel.endsWith(p.filePath))
        .map((p) => ({ atMs: p.atMs, bytes: p.bytes }));
      return {
        path: surfaceRel,
        finalBytes: f.bytes,
        growth,
      };
    });
  // The scenario's own image-gate verdict, keyed by its logged
  // `<projectId>/<surface>/<path>`. We reconcile to walked files by
  // suffix (the walked path `<surface>/<relPath>` is a suffix of the
  // logged key). Latest verdict per key wins.
  const imageGateVerdicts = new Map<string, boolean>();
  for (const line of logLines) {
    const img = parseScenarioImageLine(line);
    if (img) imageGateVerdicts.set(img.key, img.real);
  }
  const imageFiles = fileEntries
    .filter((f) => /\.(png|jpg|jpeg|webp|svg|gif)$/i.test(f.relPath))
    .map((f) => {
      const surfaceRel = `${f.surface}/${f.relPath}`;
      let real: boolean | undefined;
      for (const [key, verdict] of imageGateVerdicts) {
        if (key.endsWith(surfaceRel)) {
          real = verdict;
          break;
        }
      }
      return { path: surfaceRel, bytes: f.bytes, ...(real === undefined ? {} : { real }) };
    });
  const otherFileCount = fileEntries.length - htmlFiles.length - imageFiles.length;

  // Misc events worth surfacing — daemon spawn/shutdown, capture, history-tail
  // errors, [trial] FAIL. Drop the bytes-progress lines from cache warming;
  // they're a 25-line wall of SDXL download progress that crowds out everything
  // signal-bearing on a first-warmed petshop trial.
  const miscEvents = logLines
    .filter(
      (l) =>
        /\[(trial|capture|history-tail|cache|poll)\]/.test(l) &&
        !/\[scenario\]/.test(l) &&
        !/\[poll\] starting/.test(l) &&
        !/\[history\]/.test(l) &&
        // Drop in-progress download/install progress percent lines; keep the
        // "warming …" + "install done" / "verifying" lifecycle markers.
        !/\[cache\]\s+\S+\s+download\s+\d+%/.test(l),
    )
    .slice(0, 25); // Keep tight; the full log is on disk for deep-dives.

  // Optional sibling artifacts: read host.json + metrics.json + judge
  // if they exist. Missing files are normal on trials that pre-date
  // those layers or were run without --llm-judge.
  const host = readJson<unknown>(join(runDir, 'host.json'));
  const perf = readJson<unknown>(join(runDir, 'metrics.json'));
  const judge = readJson<unknown>(join(runDir, 'llm-judge.json'));
  // Supervisor-arm trials: consult counts / action mix / outcomes from
  // the harvested case records, so the postmortem can report the
  // Keurmeester's contribution without parsing raw JSONL.
  const keurmeester = summarizeKeurmeesterCasesSync(runDir);
  const craftbook = summarizeCraftbookDrove(runDir, result.scenarioId);
  const { timeToFirstTokenMs, firstTurnTtftMs } = parseFirstTokenTiming(
    readLines(join(runDir, 'daemon.log')).join('\n'),
    result.startedAt,
  );

  return {
    trialId: result.trialId,
    scenarioId: result.scenarioId,
    modelId: result.modelId,
    ...(result.modelTier ? { modelTier: result.modelTier } : {}),
    runDir: resolve(runDir),
    ...(host ? { host } : {}),
    ...(perf ? { perf } : {}),
    ...(judge ? { judge } : {}),
    ...(keurmeester ? { keurmeester } : {}),
    ...(craftbook ? { craftbook } : {}),
    ...(result.nativeEngineIncidents
      ? { nativeEngineIncidents: result.nativeEngineIncidents }
      : {}),
    outcome: {
      success: result.success,
      ...(result.failureMode ? { failureMode: result.failureMode } : {}),
      reason: result.reason,
      durationMs: result.durationMs,
      ...(timeoutMs ? { timeoutMs } : {}),
      budgetUsedFraction,
    },
    timing: {
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      timeToFirstArtifactMs: firstArtifactAt,
      timeToLastArtifactWriteMs: lastArtifactAt,
      timeToFirstTokenMs,
      firstTurnTtftMs,
      timeToFirstToolCallMs: firstToolCallAt,
    },
    team: {
      totalGezelsCreated,
      rolesCreated,
      missingExpectedRoles,
    },
    toolUse: {
      totalToolCalls,
      byTool,
      redFlags,
    },
    artifacts: {
      htmlFiles,
      imageFiles,
      otherFileCount,
    },
    sniff: {
      progression: sniffProgression,
      latest: lastSniff
        ? {
            filePath: lastSniff.filePath,
            bytes: lastSniff.bytes,
            score: lastSniff.score,
            scoreMax: lastSniff.scoreMax,
            signals: lastSniff.signals,
            failReason: lastSniff.failReason,
            ...(latestRuntime ?? {}),
          }
        : null,
    },
    autoAnswer: {
      total: autoAnswerEvents.length,
      byKind: { structured: structuredCount, inline: inlineCount },
      events: autoAnswerEvents,
    },
    miscEvents,
  };
}

function main(): void {
  const [, , ...args] = process.argv;
  if (args.length !== 1 || args[0] === '--help' || args[0] === '-h') {
    process.stderr.write(
      'usage: score-trial.ts <runDir>\n\n' +
        'Reads <runDir>/{result.json,log.txt,history.jsonl,sessions/,workspace/,artifacts/}\n' +
        'and emits a TrialFacts JSON object to stdout. The /eval-run skill\n' +
        'applies its 0-10 rubric to this output to produce a postmortem.\n',
    );
    process.exit(args[0] === '--help' || args[0] === '-h' ? 0 : 2);
  }
  const runDir = args[0] ?? '';
  const facts = score(runDir);
  process.stdout.write(`${JSON.stringify(facts, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
