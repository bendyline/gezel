// Core scan logic shared by the CLI (scan-runs.mjs, build-time) and the
// dev server's live /api/index endpoint (vite.config.ts). Walks an
// evals/runs tree and returns a RunsIndex object — it never writes to disk.
//
// Each trial record has just enough to render the index views without
// re-reading every file in the browser. Heavier per-trial data
// (postmortem body, full log.txt, raw facts) is fetched lazily via the
// /runs/* HTTP route.
//
// A trial dir is identified by the presence of result.json (a finished
// trial) OR status.json (an in-flight trial). Finished trials are
// immutable, so callers may pass a `cache` Map to skip re-reading them on
// repeated scans — keeping live polling O(running trials), not O(history).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Running trials older than this with no result.json are almost certainly
// abandoned (killed process never reached finalize()). Tag them 'stale' so
// they don't show "running" forever.
const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

function safeRead(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function safeJson(path) {
  const txt = safeRead(path);
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

// Walk a directory tree up to a max depth, collecting file paths.
// Used to enumerate artifact + workspace files without going hog-wild
// on deeply-nested session dirs (which already serve via /runs/*).
function walk(root, maxDepth, depth = 0, out = []) {
  if (depth > maxDepth) return out;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) {
      walk(full, maxDepth, depth + 1, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

// Extract "**Composite: 5.5 / 10** (band: capability-bound)" from a postmortem.
const COMPOSITE_RE = /\*\*Composite:\s*([\d.]+)\s*\/\s*10\*\*\s*\(band:\s*([^)]+)\)/i;
const OUTCOME_RE = /\*\*Outcome:\s*(success|timeout|crash|interrupted)/i;

function parsePostmortem(text) {
  if (!text) return null;
  const compMatch = text.match(COMPOSITE_RE);
  const outcomeMatch = text.match(OUTCOME_RE);
  return {
    composite: compMatch ? Number(compMatch[1]) : null,
    band: compMatch ? compMatch[2].trim() : null,
    outcome: outcomeMatch ? outcomeMatch[1].toLowerCase() : null,
  };
}

// A trial dir is identified by result.json (finished) or status.json
// (in-flight). Walk depth covers all known layouts:
//   standalone:        <trial>/                        depth 1
//   batch:             batch-<ts>/<trial>/             depth 2
//   matrix (flat):     matrix-<ts>/<scenario>/<trial>/ depth 3
//   matrix (by model): matrix-<ts>/<model>/<scenario>/<trial>/ depth 4
function isTrialDir(p) {
  return existsSync(join(p, 'result.json')) || existsSync(join(p, 'status.json'));
}

function findTrialDirs(root, maxDepth = 4) {
  const out = [];
  function rec(dir, depth) {
    if (depth > maxDepth) return;
    if (isTrialDir(dir)) {
      out.push(dir);
      return; // don't descend into trial subdirs
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      rec(join(dir, e.name), depth + 1);
    }
  }
  rec(root, 0);
  return out;
}

// Classify the trial's group by walking up from the trial dir.
function classifyGroup(trialDir, runsRoot) {
  const rel = relative(runsRoot, trialDir);
  const parts = rel.split('/').filter(Boolean);
  if (parts.length === 1) {
    return { kind: 'standalone', group: parts[0], scenarioDir: null };
  }
  if (parts.length === 2) {
    // batch-<ts>/<trial-id>
    return { kind: 'batch', group: parts[0], scenarioDir: null };
  }
  if (parts.length === 3) {
    // matrix-<ts>/<scenario>/<trial-id>
    return { kind: 'matrix', group: parts[0], scenarioDir: parts[1] };
  }
  // matrix-<ts>/<model>/<scenario>/<trial-id> — per-model matrix layout.
  // scenarioDir is the third part; group still the top-level matrix dir.
  return { kind: 'matrix', group: parts[0], scenarioDir: parts[2] };
}

// Pick interesting artifact files for the gallery: HTML + images + plans,
// up to a reasonable cap.
function collectArtifacts(trialDir, runsRoot) {
  const out = [];
  const trialRel = relative(runsRoot, trialDir);
  for (const sub of ['artifacts', 'workspace']) {
    const subDir = join(trialDir, sub);
    if (!existsSync(subDir)) continue;
    const files = walk(subDir, 6);
    for (const f of files) {
      const lower = f.toLowerCase();
      const isHtml = lower.endsWith('.html');
      const isImage = /\.(png|jpe?g|svg|webp)$/.test(lower);
      const isPlan = lower.endsWith('.md') && f.includes('/plans/');
      if (!isHtml && !isImage && !isPlan) continue;
      const st = safeStat(f);
      out.push({
        kind: isHtml ? 'html' : isImage ? 'image' : 'plan',
        relPath: relative(trialDir, f),
        url: `/runs/${trialRel}/${relative(trialDir, f)}`,
        bytes: st ? st.size : 0,
        mtimeMs: st ? st.mtimeMs : 0,
      });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, 24);
}

function summarize(trialDir, runsRoot) {
  const result = safeJson(join(trialDir, 'result.json'));
  const status = result ? null : safeJson(join(trialDir, 'status.json'));
  // Neither a finished result nor a running marker — not a real trial dir.
  if (!result && !status) return null;

  const host = safeJson(join(trialDir, 'host.json'));
  const metrics = safeJson(join(trialDir, 'metrics.json'));
  const pm = parsePostmortem(safeRead(join(trialDir, 'postmortem.md')));
  const group = classifyGroup(trialDir, runsRoot);
  const rel = relative(runsRoot, trialDir);

  const running = !result;
  const startedAt = (result ?? status)?.startedAt ?? null;
  const finishedAt = result?.finishedAt ?? null;
  const dayKey = startedAt ? startedAt.slice(0, 10) : null;

  // A running trial that started long ago and never finalized is stale.
  const stale = running && startedAt ? Date.parse(startedAt) < Date.now() - STALE_AFTER_MS : false;

  return {
    trialId: (result ?? status)?.trialId ?? rel.split('/').pop(),
    scenarioId: (result ?? status)?.scenarioId ?? group.scenarioDir ?? null,
    modelId: (result ?? status)?.modelId ?? null,
    runDir: rel,
    runUrl: `/runs/${rel}`,
    group: group.group,
    groupKind: group.kind,
    startedAt,
    finishedAt,
    dayKey,
    durationMs: result?.durationMs ?? null,
    running,
    success: result?.success === true,
    reason: result?.reason ?? null,
    failureMode: result
      ? (result.failureMode ?? (result.success ? null : 'fail'))
      : stale
        ? 'stale'
        : null,
    composite: pm?.composite ?? null,
    band: pm?.band ?? null,
    hasPostmortem: pm !== null,
    hasRecording: existsSync(join(trialDir, 'recording', 'transcript.json')),
    host: host
      ? {
          cpuModel: host.cpuModel ?? null,
          totalRamGb: host.totalRamGb ?? null,
          gpuModel: host.gpuModel ?? null,
          framework: host.framework ?? null,
          hostname: host.hostname ?? null,
        }
      : null,
    perf: metrics?.process
      ? {
          peakRssMb: metrics.process.peakRssMb ?? null,
          peakCpuPercent: metrics.process.peakCpuPercent ?? null,
        }
      : null,
    artifacts: collectArtifacts(trialDir, runsRoot),
  };
}

/**
 * Build the RunsIndex for a runs tree. Pure read — returns the object,
 * never writes.
 *
 * @param {object} opts
 * @param {string} opts.runsRoot   Absolute path to evals/runs.
 * @param {string} opts.repoRoot   Absolute repo root (for the relative runsRoot label).
 * @param {Map<string, {mtimeMs: number, record: object}>} [opts.cache]
 *   Optional cache of finished-trial records keyed by runDir. Finished
 *   trials are immutable, so a cache hit (matching result.json mtime)
 *   skips all file reads for that trial. Running trials are never cached.
 */
export function buildIndex({ runsRoot, repoRoot, cache }) {
  if (!existsSync(runsRoot)) {
    return {
      generatedAt: new Date().toISOString(),
      runsRoot: relative(repoRoot, runsRoot),
      counts: { trials: 0, running: 0, scored: 0, passed: 0 },
      scenarios: [],
      models: [],
      days: [],
      trials: [],
    };
  }

  const trialDirs = findTrialDirs(runsRoot, 4);
  const trials = [];
  for (const d of trialDirs) {
    const resultPath = join(d, 'result.json');
    const resultStat = safeStat(resultPath);

    // Cache fast-path: a finished trial's result.json is immutable, but
    // postmortem.md can be (re)written long after — score-retros,
    // batch-generated rubrics, etc. Key on both mtimes so a postmortem
    // update busts the cache.
    const pmStat = safeStat(join(d, 'postmortem.md'));
    const cacheKey = resultStat ? `${resultStat.mtimeMs}:${pmStat ? pmStat.mtimeMs : 0}` : null;
    if (cache && cacheKey) {
      const hit = cache.get(d);
      if (hit && hit.cacheKey === cacheKey) {
        trials.push(hit.record);
        continue;
      }
    }

    const t = summarize(d, runsRoot);
    if (!t) continue;
    trials.push(t);

    // Only cache finished trials — running ones change every poll.
    if (cache && cacheKey && !t.running) {
      cache.set(d, { cacheKey, record: t });
    }
  }

  // Running trials first (most relevant on a live dashboard), then by
  // recency. localeCompare on ISO timestamps sorts chronologically.
  trials.sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    return (b.startedAt ?? '').localeCompare(a.startedAt ?? '');
  });

  const scenarios = [...new Set(trials.map((t) => t.scenarioId).filter(Boolean))].sort();
  const models = [...new Set(trials.map((t) => t.modelId).filter(Boolean))].sort();
  const days = [...new Set(trials.map((t) => t.dayKey).filter(Boolean))].sort();

  return {
    generatedAt: new Date().toISOString(),
    runsRoot: relative(repoRoot, runsRoot),
    counts: {
      trials: trials.length,
      running: trials.filter((t) => t.running).length,
      scored: trials.filter((t) => t.composite !== null).length,
      passed: trials.filter((t) => t.success).length,
    },
    scenarios,
    models,
    days,
    trials,
  };
}
