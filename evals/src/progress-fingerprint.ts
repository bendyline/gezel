/**
 * Progress fingerprint — what changed between two polls?
 *
 * The eval harness used to fail trials on a fixed wall-clock budget,
 * which created a Parkinson's-law problem: the model would fill the
 * entire budget then write_file in the last second, every time. The
 * principle we're moving to is "measure forward progress, not elapsed
 * time" — a trial that's still touching the workspace and exchanging
 * messages at hour 7 should keep running, while a trial that has gone
 * silent for 5 minutes should fail regardless of remaining budget.
 *
 * The fingerprint is a stable, hashable snapshot of every observable
 * signal that should change when the team is doing real work:
 *
 *   1. **Workspace state** per project — file count, sorted-paths hash,
 *      max mtime, total bytes. A new file appearing, an existing file
 *      growing, or even a rename bumps the hash. Catches the dominant
 *      "I wrote to disk" signal even when no top-level tool fires
 *      (start_job and similar async paths bypass the tool-call audit).
 *   2. **Session activity** across all chat sessions — count, max
 *      lastActivityAt, max message count. A gezel responding, even
 *      with no tool call, is forward progress; an orchestration phase
 *      where the meester is consulting before acting still moves this.
 *   3. **Scenario sniff state** — score + bytes from the latest
 *      successCheck pass. Catches "the deliverable got closer to the
 *      success bar" — the highest-signal axis when the team is
 *      iterating on the target artifact (5 KB → 12 KB → 15 KB → pass).
 *   4. **Recent tool-call signature** — the last N (tool, argsHash)
 *      tuples across all sessions. Used by the rathole detector to
 *      flag "team has called X with the same args 8 times in a row" —
 *      tool-call count went up, but the model isn't actually making
 *      forward progress.
 *
 * `fingerprintEquals(a, b)` is the cheap stale check the poll loop
 * uses every cycle. `detectRathole(history)` is the deeper check that
 * looks for repetition.
 */

import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import type { SessionTelemetry } from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client/node';

export interface WorkspaceProgress {
  /** Number of files in the project workspace (recursive, excludes dirs). */
  fileCount: number;
  /** Hash of sorted file paths. Changes when files are added/removed/renamed. */
  pathsHash: string;
  /** Sum of file sizes (bytes) across the workspace. Changes when an
   *  existing file GROWS even though no path is added/removed — the
   *  "slowly writing one file" signal that fileCount/pathsHash miss.
   *  Without this, a model appending to a single existing file makes no
   *  hard-progress mark and gets false-killed by the no-progress watchdog. */
  totalBytes: number;
  /** Max file mtime across the workspace, as epoch ms. 0 if none. Also
   *  advances on an in-place rewrite that leaves byte count unchanged. */
  maxMtimeMs: number;
}

export interface ProgressFingerprint {
  /** Per-project workspace state, keyed by project id. */
  workspace: Record<string, WorkspaceProgress>;
  /** Total chat sessions across all projects (INCLUDES the meester — they
   *  drive orchestration and their activity is real progress). */
  sessionCount: number;
  /** Max `lastActivityAt` across ALL sessions, as epoch ms. 0 if none.
   *  Includes the meester for the same reason as `sessionCount` — every
   *  message commit (tool call, assistant reply, message_gezel target)
   *  bumps one session's lastActivityAt, so this monotonically advances
   *  whenever the team is doing work, even during long thinking phases
   *  that don't touch the workspace. */
  maxSessionActivityMs: number;
  /**
   * Counts of activity events scraped from `daemon.log`. Captures the
   * "engine is actively working" signal that session/workspace state
   * miss: a 5-minute generation phase processing a 19 K-token prompt
   * doesn't commit any message until done, but llama-server logs
   * `slot launch_slot_` (turn start) and `[mcp-bridge] call_tool`
   * (tool dispatch) lines throughout. Either counter ticking up is
   * proof of real work; both flat for 5+ minutes is a genuine stall.
   * Set to `null` when daemon.log is unreadable (early startup, or
   * non-llama-cpp providers that log differently).
   */
  daemonActivity: DaemonActivityCounters | null;
  /** Latest scenario sniff state. `null` until the scenario reports one. */
  sniffState: ScenarioSniffState | null;
}

export interface DaemonActivityCounters {
  /** Count of `slot launch_slot_` lines — one per generation turn start. */
  turnStarts: number;
  /** Count of `[mcp-bridge] call_tool` lines — one per MCP tool dispatch. */
  toolCalls: number;
  /**
   * Count of `call_tool` dispatches for artifact-WRITING tools
   * (write_file / write_artifact / replace_in_file / append_to_file /
   * insert_at_marker / copy_artifact_to_workspace). Distinct from the
   * total `toolCalls`, which is dominated by read-only research
   * (read_file / list_dir / grep_files, including legacy search_files calls). The retry-loop FAST path
   * ("stubborn rewriter") must gate on THIS, not the total: a team
   * holding the sniff key while emitting 19 read_file calls is
   * researching toward its next write, not re-emitting the same
   * failing artifact — squisq-review false-killed twice
   * this way (4806B/5cit and 4088B/3cit drafts, both still being
   * researched to completion when the 8-min FAST path fired on
   * read-only tool churn). A genuine rewrite changes the artifact's
   * bytes/score and resets the plateau key anyway, so a HELD key with
   * climbing write calls is the only true "stubborn rewriter" shape.
   */
  writeCalls: number;
  /**
   * Count of `slot update_slots:` lines — slot progression events
   * (prompt-eval batches, sampling init, checkpoints). Fires during
   * llama-server's structural work; useful "engine-alive" signal but
   * NOT a "making real progress" signal — can tick during rathole
   * retries. Used in the soft digest only.
   */
  slotUpdates: number;
  /**
   * Count of `[<engine>] stream-active` lines — periodic chunk-flow
   * heartbeat emitted by the provider every 5s during active token
   * streaming. The cleanest "model is actively emitting tokens"
   * signal — never fires during stalls. Used in the soft digest
   * (engine-alive); NOT in the hard digest (real-progress). Wild-
   * caught squisq-review: 3,400+ chunks streamed over
   * 10 min with no committed progress; without this signal the
   * `slot update_slots:` count went flat and the eval false-killed
   * a legitimately-active engine. Matches both `llama-cpp` and `mlx`
   * — MLX gained the pulse (it was false-stalling big
   * models mid-first-turn since only llama-cpp emitted it).
   */
  streamPulses: number;
  /**
   * Count of native sd-server log lines. Used in the soft digest so a
   * long image render still shows engine activity between chat commits.
   */
  imageLogLines: number;
  /**
   * Latest llama-server `slot print_timing:` payload, or null when the tail
   * has none. Used in the soft digest as a direct engine-alive heartbeat.
   *
   * This is the one signal that covers BOTH engine phases, which is why it
   * takes the whole timing payload rather than parsing a specific phase:
   * llama-server emits `prompt processing, n_tokens = N, progress = P, t = T`
   * every ~12–22 s during prefill and `n_decoded = N, tg = X t/s` every ~3 s
   * during decode. Every other soft signal misses at least one of them —
   * `streamPulses` only fires once decode starts AND is chunk-derived (so it
   * misses reasoning tokens the provider doesn't count as chunks), and this
   * llama-server build emits no `slot update_slots:` lines at all.
   *
   * Wild-caught 2026-07-30, both halves on gemma4-31b-q4 / M4 Max:
   *   - petshop prefilled 43,228 tokens in 339 s at 108 t/s; the 300 s soft
   *     window expired mid-prefill, before a first token could physically
   *     arrive.
   *   - tictactoe was actively DECODING — 100 timing lines in the 301 s
   *     window, 10,783 tokens generated, still running at 21 t/s — while
   *     `stream-active` emitted nothing at all.
   * Both false-failed `chat-stalled` on a demonstrably live engine.
   *
   * The payload's counters rise monotonically within a task, so the marker
   * moves whenever the engine advances and freezes the moment it stops — a
   * genuinely wedged engine still fails. This is the streaming-aware fix the
   * per-engine defer constants were a stand-in for.
   */
  engineProgressMarker: string | null;
  /**
   * True when the tail shows a native `generate_image` start without a
   * later `generate_image completed` line. The retry-loop guard uses this
   * to avoid false-failing partial HTML while the missing PNG is rendering.
   */
  imageGenerationActive: boolean;
  /**
   * Where these counters came from. `service-telemetry` = the daemon's
   * `/api/sessions/telemetry` endpoint (preferred — first-class counters);
   * `daemon-log` = the legacy log-tail regex scrape (fallback for daemons
   * predating the endpoint). Not part of any digest — the digests read
   * the counter fields by name.
   */
  source: 'service-telemetry' | 'daemon-log';
}

export interface ScenarioSniffState {
  /** Stable key the scenario uses to identify the target artifact. */
  key: string;
  /** Score the scenario assigned to the latest sniff (e.g. signals count). */
  score: number;
  /** Bytes in the latest sniffed artifact. 0 when not present yet. */
  bytes: number;
}

/**
 * Tool-call observation, captured at the chat session level. Each
 * assistant message that emits a tool call surfaces here once. The
 * `argsHash` is short — enough to detect "same call repeated" without
 * pulling the full argument JSON into memory across the trial.
 */
export interface ToolCallObservation {
  /** Session id the call fired on. */
  sessionId: string;
  /** Tool name (e.g. `write_file`, `list_dir`, `fetch_repo`). */
  tool: string;
  /** SHA-1 of the canonicalized arguments JSON, first 12 chars. */
  argsHash: string;
  /** Position within the session's tool-call sequence (0-indexed). */
  index: number;
}

/**
 * Max files we stat per project per poll for byte/mtime totals. Eval
 * deliverable workspaces hold a handful of files; this ceiling keeps a
 * pathological workspace from turning every poll into thousands of stat
 * round-trips. fileCount/pathsHash still cover all files for the
 * add/remove/rename signal — only the slow-growth byte signal is capped.
 */
const WORKSPACE_STAT_CAP = 256;

/**
 * Capture a fingerprint snapshot. Cheap — designed to run every poll
 * cycle without dominating runtime. Workspace stats are bounded
 * (5000-file cap matching `fetch_repo`'s walk). When `daemonLogPath`
 * is set, also reads activity counters from the daemon log; without
 * it those signals are unavailable and the fingerprint relies on
 * session/workspace deltas alone (legacy callers).
 */
export async function captureFingerprint(
  client: GezelClient,
  meesterId: string,
  sniffState: ScenarioSniffState | null,
  daemonLogPath?: string,
): Promise<ProgressFingerprint> {
  const workspace: Record<string, WorkspaceProgress> = {};
  let projectIds: string[] = [];
  try {
    const { projects } = await client.listProjects();
    projectIds = projects.map((p) => p.id);
  } catch {
    // Listing failed — degrade gracefully; empty workspace map still
    // produces a stable fingerprint (it just won't change on workspace
    // signals). Sessions + sniff are still tracked.
    projectIds = [];
  }
  for (const id of projectIds) {
    try {
      const listing = await client.listProjectWorkspace(id, undefined, true);
      const files = listing.files.filter((f) => !f.isDirectory);
      const paths = files.map((f) => f.path).sort();
      const pathsHash = createHash('sha1').update(paths.join('\n')).digest('hex').slice(0, 16);
      // Bytes + mtime catch the "growing one existing file" signal that
      // fileCount/pathsHash miss (no path added → those stay flat). The
      // workspace listing only carries {name,path,isDirectory}, so we stat
      // each file for its size/mtime. Bounded by WORKSPACE_STAT_CAP to keep
      // the poll cheap (eval deliverable workspaces are small; the 5000-file
      // ceiling is for pathological repos, which we don't byte-track). Stats
      // run in parallel and any failure degrades that file to 0 rather than
      // poisoning the fingerprint.
      const statTargets = paths.slice(0, WORKSPACE_STAT_CAP);
      let totalBytes = 0;
      let maxMtimeMs = 0;
      const stats = await Promise.all(
        statTargets.map((p) => client.statProjectWorkspacePath(id, p).catch(() => null)),
      );
      for (const st of stats) {
        if (!st || st.kind !== 'file') continue;
        if (typeof st.size === 'number' && Number.isFinite(st.size)) totalBytes += st.size;
        if (st.mtime) {
          const m = Date.parse(st.mtime);
          if (Number.isFinite(m) && m > maxMtimeMs) maxMtimeMs = m;
        }
      }
      workspace[id] = {
        fileCount: paths.length,
        pathsHash,
        totalBytes,
        maxMtimeMs,
      };
    } catch {
      // Project may not have an accessible workspace yet (just created,
      // no writes); skip rather than poison the fingerprint.
    }
  }

  let sessionCount = 0;
  let maxSessionActivityMs = 0;
  try {
    const { sessions } = await client.listChatSessions();
    for (const s of sessions) {
      // Include the meester. Orchestration phases (meester thinking
      // about which gezel to recruit, then sending message_gezel) are
      // real forward progress; filtering those out caused the
      // trial to false-fail at 5 minutes while the
      // meester was actively delegating.
      if (s.archived) continue;
      sessionCount += 1;
      const ts = s.lastActivityAt ? Date.parse(s.lastActivityAt) : 0;
      if (Number.isFinite(ts) && ts > maxSessionActivityMs) maxSessionActivityMs = ts;
    }
  } catch {
    // Session listing failed — same degradation as above.
  }
  // Suppress unused param to keep API stable for callers passing meesterId.
  void meesterId;

  // Prefer the daemon's first-class telemetry endpoint (counts the same
  // activity the log scrape approximated, without the 16 MB tail read).
  // Fall back to the legacy daemon.log scrape when the endpoint is
  // missing (older daemon) or the call fails this poll.
  let daemonActivity: DaemonActivityCounters | null = await readServiceTelemetryActivity(client);
  if (!daemonActivity && daemonLogPath) {
    daemonActivity = await readDaemonActivity(daemonLogPath);
  } else if (daemonActivity && daemonLogPath) {
    // Telemetry has no engine-timing signal; graft it on from the engine log
    // so a long prefill or reasoning-heavy decode still registers as engine
    // activity (see `readEngineProgressMarker`).
    daemonActivity = {
      ...daemonActivity,
      engineProgressMarker: await readEngineProgressMarker(daemonLogPath),
    };
  }

  return { workspace, sessionCount, maxSessionActivityMs, daemonActivity, sniffState };
}

/**
 * Clients whose daemon predates `/api/sessions/telemetry` (the call
 * 404s). Cached per client so every subsequent poll skips the probe
 * instead of paying a failed round-trip; transient (non-404) errors do
 * NOT poison the cache — the next poll retries.
 */
const telemetryUnsupported = new WeakSet<GezelClient>();

async function readServiceTelemetryActivity(
  client: GezelClient,
): Promise<DaemonActivityCounters | null> {
  if (telemetryUnsupported.has(client)) return null;
  try {
    const resp = await client.listSessionTelemetry();
    return telemetryToActivityCounters(resp.sessions);
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    if (status === 404 || status === 405) telemetryUnsupported.add(client);
    return null;
  }
}

/**
 * Map per-session service telemetry onto the counter shape the digests
 * were tuned against. Sums across sessions; each mapping preserves the
 * granularity of the log line it replaces:
 *   toolCalls    ← Σ toolCalls          (was `[mcp-bridge] call_tool`)
 *   writeCalls   ← Σ fileMutations      (same six-tool set)
 *   turnStarts   ← Σ turnsStarted       (true per-send turns; NOT
 *                                        generationSpurts, which is
 *                                        engine-asymmetric — llama ~1/turn
 *                                        but MLX one per ~300ms stream
 *                                        pulse. Wild-caught 2026-08-05: a
 *                                        single long MLX turn read as "870
 *                                        turns without artifact writes"
 *                                        and the chatter-path killed the
 *                                        trial for streaming too long)
 *   slotUpdates  ← Σ enginePhaseEvents  (was `slot update_slots:`)
 *   streamPulses ← Σ deltas+pulses+heartbeats (was `stream-active`)
 *   image*       ← Σ gpuEvents / any gpuTaskActive
 */
export function telemetryToActivityCounters(
  sessions: readonly SessionTelemetry[],
): DaemonActivityCounters {
  let turnStarts = 0;
  let toolCalls = 0;
  let writeCalls = 0;
  let slotUpdates = 0;
  let streamPulses = 0;
  let imageLogLines = 0;
  let imageGenerationActive = false;
  for (const s of sessions) {
    turnStarts += s.turnsStarted;
    toolCalls += s.toolCalls;
    writeCalls += s.fileMutations;
    slotUpdates += s.enginePhaseEvents;
    streamPulses += s.deltaChunks + s.wirePulses + s.heartbeats;
    imageLogLines += s.gpuEvents;
    if (s.gpuTaskActive !== null) imageGenerationActive = true;
  }
  return {
    turnStarts,
    toolCalls,
    writeCalls,
    slotUpdates,
    streamPulses,
    imageLogLines,
    imageGenerationActive,
    // The telemetry endpoint exposes no engine-timing signal; the caller
    // merges one in from the engine log so this path is not blind to an
    // engine that is working without committing (see `engineProgressMarker`).
    engineProgressMarker: null,
    source: 'service-telemetry',
  };
}

/**
 * Read just the latest prefill marker from the end of a daemon log.
 *
 * Deliberately separate from {@link readDaemonActivity}: the telemetry
 * endpoint supersedes that whole 16 MB scrape but carries no prefill signal,
 * and re-adding the full read every poll to recover one field would undo the
 * reason telemetry is preferred. A small tail is sufficient — llama-server
 * emits a batch line every ~12–22 s, so the most recent one is always near
 * the end.
 */
async function readEngineProgressMarker(path: string): Promise<string | null> {
  const TAIL_BYTES = 256 * 1024;
  try {
    const s = await stat(path);
    const startOffset = Math.max(0, s.size - TAIL_BYTES);
    const length = s.size - startOffset;
    if (length <= 0) return null;
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(length);
      await fh.read({ buffer: buf, position: startOffset, length });
      return lastEngineProgressMarker(buf.toString('utf8'));
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/**
 * Read activity counters from a daemon.log. Reads only the tail (last
 * ~16 MB) to keep per-poll cost bounded — trial logs commonly grow
 * past 100 MB, and we don't want a 100 ms file-read on every poll.
 * Counts are taken over the tail window, so the absolute number isn't
 * a true total; the fingerprint only needs *changes*, and the tail
 * always contains the most-recent activity. A stalled daemon that
 * stops writing to the log will see a stable count; a working one
 * will see the counters tick up.
 */
async function readDaemonActivity(path: string): Promise<DaemonActivityCounters | null> {
  const TAIL_CAP_BYTES = 16 * 1024 * 1024;
  try {
    const s = await stat(path);
    const fileSize = s.size;
    const startOffset = Math.max(0, fileSize - TAIL_CAP_BYTES);
    const length = fileSize - startOffset;
    if (length <= 0) return parseDaemonActivityText('');
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(length);
      await fh.read({ buffer: buf, position: startOffset, length });
      const text = buf.toString('utf8');
      return parseDaemonActivityText(text);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

export function parseDaemonActivityText(text: string): DaemonActivityCounters {
  const turnStarts = (text.match(/slot launch_slot_/g) ?? []).length;
  const toolCalls = (text.match(/\[mcp-bridge\] call_tool/g) ?? []).length;
  // Artifact-writing tools only — the "is the team actually re-emitting
  // the deliverable" signal the FAST retry-loop path needs (see
  // DaemonActivityCounters.writeCalls). Legacy camelCase spellings kept
  // for parsing pre-rename daemon logs.
  const writeCalls = (
    text.match(
      /\[mcp-bridge\] call_tool (?:write_file|writeFile|write_artifact|replace_in_file|replaceInFile|append_to_file|appendToFile|insert_at_marker|insertAtMarker|copy_artifact_to_workspace)\b/g,
    ) ?? []
  ).length;
  const slotUpdates = (text.match(/slot update_slots:/g) ?? []).length;
  const streamPulses = (text.match(/\[(?:llama-cpp|mlx)\] stream-active /g) ?? []).length;
  const imageLogLines = (text.match(/\[native\] \[sd-server\]/g) ?? []).length;
  const lastImageStart = lastMatchIndex(
    text,
    /\[native\] \[sd-server\].*stable-diffusion\.cpp:\d+\s+- generate_image \d+x\d+/g,
  );
  const lastImageComplete = lastMatchIndex(
    text,
    /\[native\] \[sd-server\].*stable-diffusion\.cpp:\d+\s+- generate_image completed\b/g,
  );
  const imageGenerationActive = lastImageStart >= 0 && lastImageStart > lastImageComplete;
  const engineProgressMarker = lastEngineProgressMarker(text);

  return {
    turnStarts,
    toolCalls,
    writeCalls,
    slotUpdates,
    streamPulses,
    engineProgressMarker,
    imageLogLines,
    imageGenerationActive,
    source: 'daemon-log',
  };
}

function lastMatchIndex(text: string, re: RegExp): number {
  let last = -1;
  for (const match of text.matchAll(re)) {
    if (typeof match.index === 'number') last = match.index;
  }
  return last;
}

/**
 * The most recent llama-server `slot print_timing:` payload, or null when the
 * tail has none. See `DaemonActivityCounters.engineProgressMarker`.
 *
 * Takes the whole payload after the `| task N |` prefix rather than parsing a
 * specific phase, deliberately: prefill and decode emit different fields, and
 * a marker that only understood one of them missed the other (the tictactoe
 * half of the 2026-07-30 wild-catch). Whatever counters a future llama.cpp
 * build reports, the payload still changes while the engine works.
 *
 * The task id is captured too, so consecutive tasks that happen to report
 * identical counters don't read as a frozen engine.
 */
export function lastEngineProgressMarker(text: string): string | null {
  let marker: string | null = null;
  for (const match of text.matchAll(
    /slot print_timing:[^|]*\|\s*task\s*(\d+)\s*\|\s*(.+?)\s*$/gm,
  )) {
    marker = `${match[1]}|${match[2]}`;
  }
  return marker;
}

/**
 * Two-tier digests of a fingerprint:
 *
 *   - `hard` — real product progress: workspace state (file
 *     add/remove/rename AND byte growth/mtime of existing files),
 *     session count, sniff state, and tool-call count. Moves when a
 *     deliverable signal happens. Deliberately EXCLUDES turn-start
 *     count and max session activity — both advance on a bare reasoning
 *     turn with no tool call and no workspace change, so including them
 *     let a busy-but-not-delivering model dodge the watchdog. The
 *     `hardProgressTimeoutMs` watchdog kills the trial when this is flat
 *     for too long, even if the engine is busy.
 *
 *   - `soft` — engine-alive heartbeat: everything in `hard` PLUS
 *     turn starts, max session activity, `slotUpdates`, and
 *     `streamPulses` (token streaming). Catches genuinely-dead daemons
 *     (crash, hang, kernel deadlock). The `softProgressTimeoutMs`
 *     watchdog kills when this is flat.
 *
 * Splitting these resolves the tension between "model is hot and
 * generating tokens, give it more time" (soft moves) and "model is
 * generating but never delivering" (hard flat). Wild-caught
 * squisq-review: 10 minutes of continuous token streaming
 * with zero tool calls, zero file writes, zero session commits. The
 * old single-digest design either killed it too soon (false-fail on
 * legitimate generation) or never (rathole forever); the two-tier
 * design kills exactly when product progress has stalled.
 */
export function digestFingerprint(fp: ProgressFingerprint): { hard: string; soft: string } {
  const workspaceEntries = Object.keys(fp.workspace)
    .sort()
    .map((id) => [id, fp.workspace[id]] as const);
  const hardPayload = JSON.stringify({
    // workspaceEntries carry fileCount + pathsHash (add/remove/rename) AND
    // totalBytes + maxMtimeMs (a single file growing in place) — so slow,
    // real file writes keep the hard digest moving even when no new path
    // appears and no top-level tool fires.
    workspace: workspaceEntries,
    sessionCount: fp.sessionCount,
    // Tool calls ARE a real-progress signal (a tool fired = the team made
    // a discrete, delivered move). Turn starts (turnStarts) and
    // maxSessionActivityMs are deliberately NOT here — both advance on
    // every committed turn including a pure reasoning turn with zero new
    // tool calls and zero workspace change, so counting them as hard
    // progress let a "busy but not delivering" model ride to the
    // maxDuration ceiling instead of being caught by the no-progress
    // watchdog. They live in the SOFT digest (engine-alive) instead.
    tools: fp.daemonActivity?.toolCalls ?? 0,
    sniff: fp.sniffState
      ? { key: fp.sniffState.key, score: fp.sniffState.score, bytes: fp.sniffState.bytes }
      : null,
  });
  const softPayload = JSON.stringify({
    hard: hardPayload,
    // Turn starts + session activity prove the engine is ALIVE (a new
    // turn committed, a session's lastActivityAt moved) without proving
    // product progress — exactly the soft-digest contract. A reasoning
    // model churning turns keeps soft moving (no false engine-dead kill)
    // while leaving hard flat (the no-progress watchdog fires as intended).
    turns: fp.daemonActivity?.turnStarts ?? 0,
    maxSessionActivityMs: fp.maxSessionActivityMs,
    daemonSoft: fp.daemonActivity
      ? {
          slotUpdates: fp.daemonActivity.slotUpdates,
          streamPulses: fp.daemonActivity.streamPulses,
          imageLogLines: fp.daemonActivity.imageLogLines,
          // Direct engine heartbeat — the only soft signal that covers both
          // prefill (before any token) and reasoning-heavy decode (which the
          // chunk-derived streamPulses undercounts). Without it either one
          // reads as a dead engine.
          engineProgressMarker: fp.daemonActivity.engineProgressMarker,
        }
      : null,
  });
  return {
    hard: createHash('sha1').update(hardPayload).digest('hex').slice(0, 16),
    soft: createHash('sha1').update(softPayload).digest('hex').slice(0, 16),
  };
}

/**
 * Rathole detector: did the last N tool calls all share the same
 * (tool, argsHash) signature? Returns the matched (tool, argsHash)
 * when so, null otherwise. Caller decides what to do with the signal
 * — typically log it and downgrade the "tool-call count went up"
 * progress signal so the rathole counts against forward progress
 * instead of for it.
 *
 * `threshold` is the suspicion bar (default 5): five identical calls
 * in a row is a strong "stuck in a loop" signal across every scenario
 * we've measured. Lower → too sensitive (legitimate retry storms
 * trigger); higher → too forgiving (model burns 10+ tool budget
 * before we notice).
 */
export function detectRathole(
  history: ToolCallObservation[],
  threshold = 5,
): { tool: string; argsHash: string; consecutive: number } | null {
  if (history.length < threshold) return null;
  const tail = history.slice(-threshold);
  const first = tail[0];
  if (!first) return null;
  const allSame = tail.every((o) => o.tool === first.tool && o.argsHash === first.argsHash);
  if (!allSame) return null;
  // Walk backwards from the end to count the actual streak (may be
  // longer than `threshold` if the loop has been running for a while).
  let consecutive = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const o = history[i];
    if (!o) break;
    if (o.tool === first.tool && o.argsHash === first.argsHash) consecutive += 1;
    else break;
  }
  return { tool: first.tool, argsHash: first.argsHash, consecutive };
}

/**
 * Hash a tool-call arguments object to a 12-char digest. Stable
 * across object key ordering. Used by the tool-call observer to
 * compute `argsHash` for rathole detection.
 */
export function hashToolCallArgs(args: unknown): string {
  const canonical = canonicalize(args);
  return createHash('sha1').update(canonical).digest('hex').slice(0, 12);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}
