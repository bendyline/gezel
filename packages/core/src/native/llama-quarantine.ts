/**
 * Per-machine record of llama-server builds that cannot run here.
 *
 * `resolveAvailableLlamaBinary` picks a backend by asking whether the
 * binary EXISTS, never whether it RUNS. When the preferred variant is
 * present but dies the instant it is spawned, nothing in the chain
 * notices: the engine supervisor just relaunches the same binary on the
 * next request, forever, while a working lower-tier build sits unused in
 * the same directory.
 *
 * That is not hypothetical. A CUDA build shipped in native-v0.1.29 died
 * with SIGILL before binding its port on a Haswell CPU, and the user's
 * only route out was to hand-pin Vulkan in Settings — after the crash had
 * been misdiagnosed several times, because the error surfaced as a bare
 * signal name with no attribution.
 *
 * So: when a variant crashes before it is ever ready, write it down here,
 * and let backend resolution route around it on the next launch.
 *
 * ## Three strikes
 *
 * One such crash is a strike, not a quarantine. A machine in a bad state —
 * a driver mid-update, a GPU still recovering from a reset — can kill a
 * build that runs fine after a reboot, and demoting it for every model until
 * the next engine release over one bad moment is the worse failure.
 * {@link LLAMA_QUARANTINE_STRIKES} crashes in a row of the same bytes, with no
 * successful start between them, quarantine the build; any start that
 * reaches readiness clears its strikes.
 *
 * ## Undo
 *
 * A person can lift a quarantine from the engine's Settings tab
 * (`DELETE /api/engines/llama-cpp/quarantine/:backend`). The build then gets
 * a fresh count: three more silent crashes write it down again.
 *
 * ## Why the fingerprint, and not a version string
 *
 * An entry pins the exact bytes that crashed — `<size>:<mtimeMs>` of the
 * binary — rather than an engine or release version. A quarantine has to
 * expire the moment the offending build is replaced, and a version key
 * cannot promise that: the fix for the SIGILL above was a compiler-flag
 * change at an UNCHANGED llama.cpp pin. Keying on `LLAMA_ENGINE_VERSION`
 * would have left every affected machine demoted to Vulkan permanently,
 * with the repaired CUDA build sitting right there. Fingerprinting the
 * file means an upgrade re-enables the backend on its own, and a machine
 * that is genuinely too old re-quarantines after one cheap crash.
 *
 * Deliberately NOT consulted when the user has pinned a backend
 * explicitly: an override is a decision, and silently overriding the
 * override would be worse than the failure it avoids. The pin stands, the
 * crash still reports.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  type LlamaBackend,
  type ResolvedLlamaBinary,
  resolveAvailableLlamaBinary,
} from './llama-backend.js';

export interface LlamaQuarantineEntry {
  backend: LlamaBackend;
  /** `<size>:<mtimeMs>` of the binary that crashed — see the module docstring. */
  fingerprint: string;
  /** Signal that killed it (`SIGILL`), or `exit:<code>` when it exited normally. */
  signal: string;
  /** Human-readable explanation, surfaced in the backend-resolution reason. */
  reason: string;
  /** ISO 8601 timestamp of the crash that created this entry. */
  at: string;
  /**
   * Crashes in a row that wrote the entry down. Absent from entries written
   * before strikes, which quarantined on the first crash.
   */
  crashes?: number;
}

/**
 * Crashes of one build before it is quarantined. Every one must be a silent
 * death before readiness (unrunnable-build.ts) of the same bytes, with no
 * successful start of that build between them.
 */
export const LLAMA_QUARANTINE_STRIKES = 3;

/** A build that crashed before readiness, not yet often enough to be quarantined. */
export interface LlamaQuarantineStrike {
  backend: LlamaBackend;
  /** `<size>:<mtimeMs>`, as for an entry: a replaced binary starts its count over. */
  fingerprint: string;
  /** Crashes in a row. */
  count: number;
  /** Signal or `exit:<code>` of the latest one. */
  signal: string;
  /** ISO 8601 timestamp of the latest one. */
  at: string;
}

interface QuarantineFile {
  schemaVersion: number;
  entries: LlamaQuarantineEntry[];
  /**
   * Added after schema 1 shipped. Readers that predate it ignore the key, so
   * the version stays 1; a writer that predates it drops the strikes, which
   * only restarts a count.
   */
  strikes?: LlamaQuarantineStrike[];
}

interface QuarantineContents {
  entries: LlamaQuarantineEntry[];
  strikes: LlamaQuarantineStrike[];
}

const SCHEMA_VERSION = 1;

/** Injection seam — tests supply fakes, production uses `node:fs`. */
export interface QuarantineIo {
  readFile?: (path: string) => string;
  writeFile?: (path: string, data: string) => void;
  statFile?: (path: string) => { size: number; mtimeMs: number };
  mkdir?: (path: string) => void;
  now?: () => Date;
}

export function llamaQuarantinePath(home: string): string {
  return join(home, 'engines', 'llama-cpp', 'unusable.json');
}

/**
 * Identity of the bytes at `path`, or null when it cannot be stat'd.
 *
 * Size alone is nearly sufficient — a rebuilt engine is essentially never
 * byte-identical in length — but mtime costs nothing extra from the same
 * stat call and closes the gap.
 */
export function binaryFingerprint(path: string, io: QuarantineIo = {}): string | null {
  const statFile = io.statFile ?? ((p: string) => statSync(p));
  try {
    const info = statFile(path);
    return `${info.size}:${Math.trunc(info.mtimeMs)}`;
  } catch {
    return null;
  }
}

function readQuarantineFile(home: string, io: QuarantineIo): QuarantineContents {
  const readFile = io.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  try {
    const parsed = JSON.parse(readFile(llamaQuarantinePath(home))) as Partial<QuarantineFile>;
    if (parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.entries)) {
      return { entries: [], strikes: [] };
    }
    return {
      entries: parsed.entries.filter(isEntry),
      strikes: Array.isArray(parsed.strikes) ? parsed.strikes.filter(isStrike) : [],
    };
  } catch {
    // Missing (the common case), unreadable, or malformed. A quarantine
    // is an optimization over crashing — never let a bad file become the
    // reason the engine won't start.
    return { entries: [], strikes: [] };
  }
}

function writeQuarantineFile(home: string, contents: QuarantineContents, io: QuarantineIo): void {
  const path = llamaQuarantinePath(home);
  const mkdir = io.mkdir ?? ((p: string) => void mkdirSync(p, { recursive: true }));
  const writeFile = io.writeFile ?? ((p: string, data: string) => writeFileSync(p, data, 'utf8'));
  const file: QuarantineFile = { schemaVersion: SCHEMA_VERSION, ...contents };
  mkdir(dirname(path));
  writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
}

export function readLlamaQuarantine(home: string, io: QuarantineIo = {}): LlamaQuarantineEntry[] {
  return readQuarantineFile(home, io).entries;
}

/** Builds counting toward a quarantine. Not quarantined: discovery ignores these. */
export function readLlamaQuarantineStrikes(
  home: string,
  io: QuarantineIo = {},
): LlamaQuarantineStrike[] {
  return readQuarantineFile(home, io).strikes;
}

/**
 * True when `backend`'s binary at `binaryPath` is the same file that
 * crashed before. A fingerprint mismatch means the build was replaced, so
 * the entry no longer applies and the backend gets another chance.
 */
export function isBinaryQuarantined(
  entries: readonly LlamaQuarantineEntry[],
  backend: LlamaBackend,
  binaryPath: string,
  io: QuarantineIo = {},
): boolean {
  const entry = entries.find((e) => e.backend === backend);
  if (!entry) return false;
  const current = binaryFingerprint(binaryPath, io);
  return current !== null && current === entry.fingerprint;
}

/**
 * Quarantine `backend`'s binary now, whatever its strikes. Replaces any
 * existing entry for the same backend and clears its strikes. Crashes are
 * counted through {@link recordLlamaStartupCrash}, which calls this on the
 * last one.
 *
 * Returns the entry written, or null when the binary could not be
 * fingerprinted (it vanished mid-crash) — there is nothing meaningful to
 * pin the quarantine to in that case, and a stale-forever entry is worse
 * than none.
 */
export function recordLlamaQuarantine(
  home: string,
  input: {
    backend: LlamaBackend;
    binaryPath: string;
    signal: string;
    reason: string;
    crashes?: number;
  },
  io: QuarantineIo = {},
): LlamaQuarantineEntry | null {
  const fingerprint = binaryFingerprint(input.binaryPath, io);
  if (!fingerprint) return null;
  const now = io.now?.() ?? new Date();
  const entry: LlamaQuarantineEntry = {
    backend: input.backend,
    fingerprint,
    signal: input.signal,
    reason: input.reason,
    at: now.toISOString(),
    ...(input.crashes !== undefined ? { crashes: input.crashes } : {}),
  };
  const { entries, strikes } = readQuarantineFile(home, io);
  writeQuarantineFile(
    home,
    {
      entries: [...entries.filter((e) => e.backend !== input.backend), entry],
      strikes: strikes.filter((s) => s.backend !== input.backend),
    },
    io,
  );
  return entry;
}

/**
 * Count one unrunnable-looking startup crash against `backend`'s build, and
 * quarantine it when the count reaches `threshold`. `strikes` is the count
 * after this crash; `entry` is set only when this crash wrote the build down.
 * A binary that cannot be fingerprinted counts nothing.
 */
export function recordLlamaStartupCrash(
  home: string,
  input: { backend: LlamaBackend; binaryPath: string; signal: string; reason: string },
  io: QuarantineIo = {},
  threshold: number = LLAMA_QUARANTINE_STRIKES,
): { strikes: number; entry: LlamaQuarantineEntry | null } {
  const fingerprint = binaryFingerprint(input.binaryPath, io);
  if (!fingerprint) return { strikes: 0, entry: null };
  const { entries, strikes } = readQuarantineFile(home, io);
  const prior = strikes.find((s) => s.backend === input.backend && s.fingerprint === fingerprint);
  const count = (prior?.count ?? 0) + 1;
  if (count >= threshold) {
    return { strikes: count, entry: recordLlamaQuarantine(home, { ...input, crashes: count }, io) };
  }
  const now = io.now?.() ?? new Date();
  writeQuarantineFile(
    home,
    {
      entries,
      strikes: [
        ...strikes.filter((s) => s.backend !== input.backend),
        { backend: input.backend, fingerprint, count, signal: input.signal, at: now.toISOString() },
      ],
    },
    io,
  );
  return { strikes: count, entry: null };
}

/**
 * A start of `backend`'s build reached readiness, so its crashes so far were
 * not in a row. Writes only when there was a count to clear; true if so.
 */
export function clearLlamaStartupStrikes(
  home: string,
  backend: LlamaBackend,
  io: QuarantineIo = {},
): boolean {
  const { entries, strikes } = readQuarantineFile(home, io);
  if (!strikes.some((s) => s.backend === backend)) return false;
  writeQuarantineFile(home, { entries, strikes: strikes.filter((s) => s.backend !== backend) }, io);
  return true;
}

/**
 * Lift `backend`'s quarantine, and its strikes with it, so the build gets a
 * fresh count. True when there was anything to remove.
 */
export function clearLlamaQuarantine(
  home: string,
  backend: LlamaBackend,
  io: QuarantineIo = {},
): boolean {
  const { entries, strikes } = readQuarantineFile(home, io);
  const kept = {
    entries: entries.filter((e) => e.backend !== backend),
    strikes: strikes.filter((s) => s.backend !== backend),
  };
  if (kept.entries.length === entries.length && kept.strikes.length === strikes.length) {
    return false;
  }
  writeQuarantineFile(home, kept, io);
  return true;
}

/**
 * Where `candidate`'s build sits beside `binaryPath`, a `backend` build in the
 * bundled layout (`<platformKey>-<backend>/`). Null for a layout without
 * variant directories.
 */
export function llamaVariantBinaryPath(
  binaryPath: string,
  backend: LlamaBackend,
  candidate: LlamaBackend,
): string | null {
  const variantDir = dirname(binaryPath);
  const suffix = `-${backend}`;
  if (!basename(variantDir).endsWith(suffix)) return null;
  const platformKey = basename(variantDir).slice(0, -suffix.length);
  return join(dirname(variantDir), `${platformKey}-${candidate}`, basename(binaryPath));
}

/**
 * The best usable build beside `binaryPath` (a `backend` build), walking
 * `preferred`'s fallback chain the way discovery does. Null for a layout
 * without variant directories, or when nothing usable is bundled.
 */
export function resolveLlamaVariantBinary(
  binaryPath: string,
  backend: LlamaBackend,
  preferred: LlamaBackend,
  isUsable: (backend: LlamaBackend, path: string) => boolean,
  fileExists: (path: string) => boolean = existsSync,
): ResolvedLlamaBinary | null {
  if (llamaVariantBinaryPath(binaryPath, backend, backend) === null) return null;
  return resolveAvailableLlamaBinary(
    preferred,
    (candidate) => {
      const path = llamaVariantBinaryPath(binaryPath, backend, candidate);
      return path !== null && fileExists(path) ? path : null;
    },
    true,
    isUsable,
  );
}

/**
 * The build to launch in place of `backend`'s, which was just quarantined:
 * the next one down discovery's own fallback chain, from the sibling
 * directory each bundled variant ships in (`<platformKey>-<backend>/`).
 *
 * Discovery reads the quarantine only at startup, so without this a crash
 * routed around nothing until the app restarted — every retry in between
 * relaunched the build that had just been written down as unrunnable.
 *
 * Null for a variant-less layout (one build, nothing beside it) or when
 * nothing usable is bundled below; the quarantine then applies from the
 * next start, as before.
 */
export function resolveLlamaFallbackBinary(
  binaryPath: string,
  backend: LlamaBackend,
  isUsable: (backend: LlamaBackend, path: string) => boolean,
  fileExists: (path: string) => boolean = existsSync,
): ResolvedLlamaBinary | null {
  return resolveLlamaVariantBinary(
    binaryPath,
    backend,
    backend,
    (candidate, path) => candidate !== backend && isUsable(candidate, path),
    fileExists,
  );
}

function isEntry(value: unknown): value is LlamaQuarantineEntry {
  if (value === null || typeof value !== 'object') return false;
  const e = value as Partial<LlamaQuarantineEntry>;
  return (
    typeof e.backend === 'string' &&
    typeof e.fingerprint === 'string' &&
    typeof e.signal === 'string' &&
    typeof e.reason === 'string' &&
    typeof e.at === 'string'
  );
}

function isStrike(value: unknown): value is LlamaQuarantineStrike {
  if (value === null || typeof value !== 'object') return false;
  const s = value as Partial<LlamaQuarantineStrike>;
  return (
    typeof s.backend === 'string' &&
    typeof s.fingerprint === 'string' &&
    typeof s.count === 'number' &&
    Number.isInteger(s.count) &&
    s.count > 0 &&
    typeof s.signal === 'string' &&
    typeof s.at === 'string'
  );
}
