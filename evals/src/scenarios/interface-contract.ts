import { existsSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { postMissingDeliverableFeedback, postSniffFeedback } from '../sniff-feedback.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import { listAllFiles, materializeProjectWorkspace, spawnAndAwait } from './helpers.ts';

/**
 * Interface-contract — two workers must agree on a shared interface.
 *
 * Axis: multi-worker COUPLED coordination via the meester-macro path
 * (no seeded worker — the scenario prompt is the real user ask, like
 * tankcombat). petshop's two roles are loosely coupled (HTML + PNG);
 * nothing else tests whether independently-produced halves FIT. The
 * mission asks for a tiny TS event pipeline in three files —
 * src/types.ts (shared EventRecord + Sink), src/producer.ts
 * (makeEvents), src/consumer.ts (consume routing to sink.handle) — and
 * suggests the lead split producer and consumer between two developers.
 *
 * Acceptance is fully behavioral: `tsc --noEmit` clean AND a
 * harness-owned integration script that imports both halves and
 * round-trips events. The integration script is NEVER seeded into the
 * workspace (no project exists at setup time on the meester path, and
 * a seeded script could be tampered with) — the grader writes
 * `INTEGRATION_MJS` into its own materialized tmp copy and runs it
 * there under Node 24 type-stripping.
 *
 * Idiom-agnosticism: relative import specifiers in the materialized
 * copy are normalized to explicit `.ts` ('./types', './types.js', and
 * './types.ts' all mean the same file — Node type-stripping only
 * accepts the last) so the gate measures interface agreement, not
 * import-extension style. consume() may return a plain object OR a Map.
 *
 * Team-shape metric (non-gating): the number of distinct non-meester
 * chat sessions is reported in the success reason, so solo completion
 * still passes but the delegation shape is visible in postmortems.
 */

const requireFromHere = createRequire(import.meta.url);
function resolveTscBin(): string {
  const tscPkg = requireFromHere.resolve('typescript/package.json');
  return join(dirname(tscPkg), 'bin', 'tsc');
}

export const REQUIRED_PIPELINE_FILES = [
  'src/types.ts',
  'src/producer.ts',
  'src/consumer.ts',
] as const;

export const INTERFACE_CONTRACT_PROMPT = [
  'Create a new project for this work (e.g. `Event Pipeline`) and build a tiny TypeScript',
  'event pipeline in it, as exactly three workspace files:',
  '`src/types.ts` — the SHARED contract: export an `EventRecord` interface with `kind: string`',
  'and a `payload` field, and a `Sink` interface with a `handle(kind, payload): void` method.',
  '`src/producer.ts` — export `makeEvents(): EventRecord[]` returning at least 5 events',
  'spanning at least 2 different kinds, each with a payload.',
  '`src/consumer.ts` — export `consume(events, sink)` that routes EVERY event to',
  '`sink.handle(kind, payload)` and returns the counts by kind (a plain object or Map of',
  'kind → count). Both producer and consumer must import their types from `src/types.ts` —',
  'that shared file is the contract that keeps the two halves compatible, so write it first',
  'and do not let the two sides drift. This splits naturally: the lead should consider',
  'splitting producer and consumer between two developers.',
  'Acceptance is checked automatically every few seconds: `tsc --noEmit` must pass over the',
  'three files, and a read-only `integration.mjs` script (run by the harness — you never',
  'write or see it) imports `src/producer.ts` and `src/consumer.ts`, runs',
  '`consume(makeEvents(), sink)` with a recording sink, and verifies the routing and counts.',
  'Use explicit `.ts` extensions in relative imports (e.g. `from "./types.ts"`). Plain',
  'TypeScript only — no npm install, no dependencies, no build step.',
].join(' ');

// ─────────────────────────────────────────────────────────────────────
// The harness-owned gate. tsconfig/package.json/integration.mjs are
// written by the GRADER into its tmp copy — they never enter the
// workspace and cannot be tampered with.

const GATE_PKG_JSON = `{
  "name": "event-pipeline-gate",
  "private": true,
  "type": "module"
}
`;

// EMIT, not noEmit: the integration step runs COMPILED JS. Node's
// type-stripping was the original runtime, but it does no cross-module
// type analysis — `import { EventRecord } from './types.ts'` where
// EventRecord is an interface is valid TypeScript (tsc elides it on
// emit) yet dies at strip-time with "does not provide an export named
// 'EventRecord'". Wild-caught on the very first smoke trial: the model
// wrote correct TS and the gate false-failed it. tsc emit with
// `rewriteRelativeImportExtensions` (.ts → .js in emitted specifiers)
// gives full compiler semantics; emit failure carries the same
// diagnostics the old --noEmit check did.
const GATE_TSCONFIG_JSON = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "rewriteRelativeImportExtensions": true,
    "rootDir": "src",
    "outDir": "emit"
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "src/**/*.mts"]
}
`;

const INTEGRATION_MARKER = '__GEZEL_INTERFACE_CONTRACT__';

/**
 * Imports the model's producer + consumer (Node type-strips the .ts
 * sources directly) and asserts the contract behaviorally: ≥5 events of
 * ≥2 kinds, every event routed to sink.handle(kind, payload), and the
 * returned counts-by-kind (object or Map) matching reality. Every
 * failure prints a single marker line whose `why` is relayed verbatim
 * into team chat.
 */
export const INTEGRATION_MJS = `const MARKER = '${INTEGRATION_MARKER}';
const fail = (why) => {
  console.log(MARKER + JSON.stringify({ ok: false, why: String(why).slice(0, 400) }));
  process.exit(1);
};
let producerMod = null;
let consumerMod = null;
try {
  producerMod = await import('./emit/producer.js');
} catch (err) {
  fail('src/producer.ts failed to import (compiled): ' + ((err && err.message) || err));
}
try {
  consumerMod = await import('./emit/consumer.js');
} catch (err) {
  fail('src/consumer.ts failed to import (compiled): ' + ((err && err.message) || err));
}
const makeEvents = producerMod.makeEvents;
if (typeof makeEvents !== 'function') fail('src/producer.ts does not export a makeEvents() function');
const consume = consumerMod.consume;
if (typeof consume !== 'function') fail('src/consumer.ts does not export a consume(events, sink) function');
let events = null;
try {
  events = makeEvents();
} catch (err) {
  fail('makeEvents() threw: ' + ((err && err.message) || err));
}
if (!Array.isArray(events)) fail('makeEvents() must return an EventRecord[], got ' + typeof events);
if (events.length < 5) fail('makeEvents() returned only ' + events.length + ' event(s) — need at least 5');
for (let i = 0; i < events.length; i++) {
  const e = events[i];
  if (!e || typeof e !== 'object') fail('events[' + i + '] is not an object');
  if (typeof e.kind !== 'string' || e.kind.length === 0) fail('events[' + i + '].kind must be a non-empty string');
  if (!('payload' in e)) fail('events[' + i + '] has no payload property');
}
const distinctKinds = [...new Set(events.map((e) => e.kind))];
if (distinctKinds.length < 2) fail('makeEvents() produced only ' + distinctKinds.length + ' distinct kind(s) — need at least 2');
const calls = [];
const sink = {
  handle(kind, payload) {
    calls.push({ kind, payload });
  },
};
let counts = null;
try {
  counts = consume(events, sink);
} catch (err) {
  fail('consume(events, sink) threw: ' + ((err && err.message) || err));
}
if (calls.length !== events.length) {
  fail('sink.handle was called ' + calls.length + ' time(s) for ' + events.length + ' event(s) — consume must route EVERY event to sink.handle(kind, payload)');
}
const expected = {};
for (const e of events) expected[e.kind] = (expected[e.kind] || 0) + 1;
const routed = {};
for (const c of calls) routed[c.kind] = (routed[c.kind] || 0) + 1;
for (const kind of Object.keys(expected)) {
  if (routed[kind] !== expected[kind]) {
    fail('sink.handle saw ' + (routed[kind] || 0) + ' ' + JSON.stringify(kind) + ' event(s), expected ' + expected[kind]);
  }
}
let entries = null;
if (counts instanceof Map) entries = [...counts.entries()];
else if (counts && typeof counts === 'object') entries = Object.entries(counts);
if (!entries) fail('consume() must return counts-by-kind (a plain object or Map), got ' + (counts === null ? 'null' : typeof counts));
const countByKind = {};
for (const [kind, n] of entries) countByKind[kind] = n;
for (const kind of Object.keys(expected)) {
  if (Number(countByKind[kind]) !== expected[kind]) {
    fail('consume() returned counts[' + JSON.stringify(kind) + '] = ' + countByKind[kind] + ', expected ' + expected[kind]);
  }
}
for (const [kind, n] of entries) {
  if (!(kind in expected) && Number(n) !== 0) fail('consume() returned a count for unknown kind ' + JSON.stringify(kind));
}
console.log(MARKER + JSON.stringify({ ok: true, events: events.length, kinds: distinctKinds.length }));
`;

/**
 * Rewrite RELATIVE import/export specifiers to explicit `.ts` so the
 * grader copy runs under Node type-stripping regardless of which
 * import-extension idiom the model chose. `tsExistsForSpecBase` is
 * consulted with the extension-stripped specifier (e.g. './types') so
 * specifiers pointing at real non-TS files are left alone. Pure —
 * exported for the grader test.
 */
export function normalizeRelativeTsImports(
  source: string,
  tsExistsForSpecBase: (specBase: string) => boolean,
): string {
  return source.replace(
    /((?:from|import)\s*\(?\s*['"])(\.\.?\/[^'"]+)(['"])/g,
    (whole, pre: string, spec: string, post: string) => {
      if (/\.(?:ts|mts|cts|tsx|json|css|node)$/i.test(spec)) return whole;
      const extMatch = spec.match(/\.(?:js|mjs|cjs|jsx)$/i);
      const base = extMatch ? spec.slice(0, -extMatch[0].length) : spec;
      if (!tsExistsForSpecBase(base)) return whole;
      return `${pre}${base}.ts${post}`;
    },
  );
}

async function rewriteImportsToTs(dir: string): Promise<void> {
  const srcDir = join(dir, 'src');
  let entries: Dirent[];
  try {
    entries = await readdir(srcDir, { recursive: true, withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(?:ts|tsx|mts)$/.test(entry.name)) continue;
    const filePath = join(entry.parentPath, entry.name);
    const original = await readFile(filePath, 'utf8');
    const rewritten = normalizeRelativeTsImports(original, (specBase) =>
      existsSync(resolve(dirname(filePath), `${specBase}.ts`)),
    );
    if (rewritten !== original) await writeFile(filePath, rewritten, 'utf8');
  }
}

export interface GateResult {
  ok: boolean;
  stage: 'files' | 'tsc' | 'integration' | 'pass';
  /** Verbatim detail from the failing gate (tsc error lines / integration why). */
  detail: string;
}

/**
 * Run the full acceptance gate against a directory containing the
 * model's `src/` tree: normalize import extensions, drop in the
 * grader-owned package.json + tsconfig.json + integration.mjs, then
 * `tsc --noEmit` followed by `node integration.mjs`. Exported so the
 * grader test exercises the REAL gate against reference solutions.
 */
export async function runInterfaceContractGateInDir(dir: string): Promise<GateResult> {
  for (const p of REQUIRED_PIPELINE_FILES) {
    if (!existsSync(join(dir, p))) {
      return { ok: false, stage: 'files', detail: `${p} is missing from the workspace` };
    }
  }
  await rewriteImportsToTs(dir);
  await writeFile(join(dir, 'package.json'), GATE_PKG_JSON, 'utf8');
  await writeFile(join(dir, 'tsconfig.json'), GATE_TSCONFIG_JSON, 'utf8');
  await writeFile(join(dir, 'integration.mjs'), INTEGRATION_MJS, 'utf8');

  const tsc = resolveTscBin();
  // Emit (see GATE_TSCONFIG_JSON): same diagnostics as --noEmit, plus
  // the compiled JS the integration step runs.
  const tscResult = await spawnAndAwait(process.execPath, [tsc, '-p', dir], {
    cwd: dir,
    timeoutMs: 90_000,
  });
  if (tscResult.exitCode !== 0) {
    const errorLines = tscResult.stdout
      .split('\n')
      .filter((l) => /error TS\d+:/i.test(l))
      .slice(0, 3)
      .map((l) => l.trim());
    const detail =
      errorLines.length > 0
        ? errorLines.join(' | ').slice(0, 600)
        : `${tscResult.stdout}\n${tscResult.stderr}`.trim().slice(0, 600) ||
          `tsc exited ${tscResult.exitCode}${tscResult.timedOut ? ' (timed out)' : ''}`;
    return { ok: false, stage: 'tsc', detail };
  }

  // Plain node over the tsc-emitted JS — no type-stripping flags needed.
  const run = await spawnAndAwait(process.execPath, ['--no-warnings', 'integration.mjs'], {
    cwd: dir,
    timeoutMs: 30_000,
  });
  const markerLine = run.stdout.split('\n').find((l) => l.startsWith(INTEGRATION_MARKER));
  if (!markerLine) {
    const detail =
      `${run.stderr || run.stdout}`.trim().slice(0, 600) ||
      `integration.mjs exited ${run.exitCode} with no output${run.timedOut ? ' (timed out)' : ''}`;
    return { ok: false, stage: 'integration', detail };
  }
  try {
    const parsed = JSON.parse(markerLine.slice(INTEGRATION_MARKER.length)) as {
      ok: boolean;
      why?: string;
      events?: number;
      kinds?: number;
    };
    if (!parsed.ok) {
      return {
        ok: false,
        stage: 'integration',
        detail: parsed.why ?? 'integration failed without a reason',
      };
    }
    return {
      ok: true,
      stage: 'pass',
      detail: `node integration.mjs passed: ${parsed.events} event(s) across ${parsed.kinds} kind(s) routed and counted`,
    };
  } catch {
    return { ok: false, stage: 'integration', detail: markerLine.slice(0, 600) };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Daemon-facing plumbing.

function simpleHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const gateCache = new WeakMap<EvalContext, { lastHash: string; lastResult: GateResult }>();

export const interfaceContractScenario: EvalScenario = {
  id: 'interface-contract',
  description:
    'Coupled delegation via the meester path: ship a three-file TypeScript event pipeline (shared src/types.ts contract, src/producer.ts, src/consumer.ts) whose independently-produced halves must fit — graded by tsc --noEmit plus a harness-owned integration script that round-trips events through sink.handle.',
  prompt: INTERFACE_CONTRACT_PROMPT,
  requiredPromptEvidence: [{ signal: 'paths-named', pattern: /src\/producer\.ts/ }],
  timeoutMs: 30 * 60_000,
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const { client, log, logChanged, recordSniff } = ctx;
    const { projects } = await client.listProjects();
    // Newest non-default project first — the prompt asks the meester to
    // create a fresh project for this work.
    const candidates = projects
      .filter((p) => p.id !== 'default')
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    if (candidates.length === 0) {
      logChanged('project', '[scenario] no non-default project yet');
      return { done: false };
    }

    let targetProjectId: string | null = null;
    let best: {
      projectId: string;
      present: string[];
      files: Awaited<ReturnType<typeof listAllFiles>>;
    } | null = null;
    for (const project of candidates) {
      const files = await listAllFiles(client, project.id);
      const workspacePaths = new Set(
        files.filter((f) => f.surface === 'workspace').map((f) => f.filePath),
      );
      const present = REQUIRED_PIPELINE_FILES.filter((p) => workspacePaths.has(p));
      if (!best || present.length > best.present.length) {
        best = { projectId: project.id, present: [...present], files };
      }
      if (present.length === REQUIRED_PIPELINE_FILES.length) {
        targetProjectId = project.id;
        break;
      }
    }

    if (!targetProjectId) {
      const present = best?.present ?? [];
      const missingPath = REQUIRED_PIPELINE_FILES.find((p) => !present.includes(p));
      logChanged(
        'files',
        `[scenario] interface-contract files present: ${present.join(',') || 'none'} (waiting for ${missingPath})`,
      );
      recordSniff?.({ key: 'interface-contract', score: present.length, bytes: 0 });
      if (best && missingPath) {
        const baseName = missingPath.split('/').pop() ?? missingPath;
        const nearMiss = best.files.find(
          (f) =>
            f.filePath !== missingPath &&
            (f.filePath.toLowerCase().endsWith(`/${baseName}`) ||
              f.filePath.toLowerCase() === baseName),
        );
        await postMissingDeliverableFeedback(ctx, missingPath, {
          projectId: best.projectId,
          minPolls: 24,
          repeatEvery: 24,
          maxNudges: 3,
          ...(nearMiss ? { nearMiss: { path: nearMiss.filePath, location: nearMiss.rooted } } : {}),
        });
      }
      return { done: false };
    }

    const texts: string[] = [];
    for (const p of REQUIRED_PIPELINE_FILES) {
      const blob = await client.fetchProjectWorkspaceBlob(targetProjectId, p);
      texts.push(await blob.text());
    }
    const totalBytes = texts.reduce((sum, t) => sum + t.length, 0);
    const contentHash = texts.map((t) => `${t.length.toString(36)}.${simpleHash(t)}`).join('/');

    let result: GateResult;
    const cached = gateCache.get(ctx);
    if (cached && cached.lastHash === contentHash) {
      result = cached.lastResult;
    } else {
      const tmp = await mkdtemp(`${tmpdir()}/gezel-eval-interface-contract-`);
      try {
        await materializeProjectWorkspace(client, targetProjectId, tmp, {
          include: /^src\/.*\.(?:ts|tsx|mts|js|mjs|cjs)$/i,
        });
        result = await runInterfaceContractGateInDir(tmp);
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {});
      }
      gateCache.set(ctx, { lastHash: contentHash, lastResult: result });
      log(
        `[scenario] gate ran: stage=${result.stage} ok=${result.ok} detail="${result.detail.slice(0, 200)}"`,
      );
    }

    const signals = ['files-present'];
    if (result.ok || result.stage === 'integration') signals.push('tsc-clean');
    if (result.ok) signals.push('integration-pass');
    const score = REQUIRED_PIPELINE_FILES.length + (signals.length - 1);
    logChanged(
      'sniff',
      `[scenario] interface-contract bytes=${totalBytes} score=${score}/5 signals=${signals.join(',')}${result.ok ? '' : ` failReason="${result.detail.slice(0, 160)}"`}`,
    );
    recordSniff?.({ key: 'interface-contract', score, bytes: totalBytes });

    if (result.ok) {
      // Team-shape metric — reported, not gated: solo completion passes,
      // but postmortems can see whether the work was actually split.
      let teamNote = '';
      try {
        const { sessions } = await client.listChatSessions();
        const distinct = new Set(
          sessions.filter((s) => s.gezelId !== ctx.meesterId && !s.archived).map((s) => s.gezelId),
        );
        teamNote = ` — team shape: ${distinct.size} distinct non-meester session(s)${distinct.size >= 2 ? ' (work was split)' : ' (solo)'}`;
      } catch {
        teamNote = '';
      }
      return {
        done: true,
        success: true,
        reason: `tsc emit clean + ${result.detail}${teamNote}`,
      };
    }

    const failReason =
      result.stage === 'tsc'
        ? `tsc --noEmit failed: ${result.detail}`
        : `node integration.mjs failed: ${result.detail}`;
    const missing =
      result.stage === 'tsc' ? ['tsc-clean', 'integration-pass'] : ['integration-pass'];
    const targetFile = result.detail.match(/src\/[\w.-]+\.tsx?/)?.[0] ?? 'src/consumer.ts';
    await postSniffFeedback(
      ctx,
      targetFile,
      { ok: false, signals, score, failReason, missingRequiredSignals: missing },
      {
        projectId: targetProjectId,
        sourceText: texts.join('\n'),
        // Coordination-sensitive multi-worker scenario: the implementer
        // may be mid-turn, so copy the coordinator (petshop pattern).
        notifyMeester: true,
      },
    );
    return { done: false };
  },
};
