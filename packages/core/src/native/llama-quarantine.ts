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

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LlamaBackend } from './llama-backend.js';

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
}

interface QuarantineFile {
  schemaVersion: number;
  entries: LlamaQuarantineEntry[];
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

export function readLlamaQuarantine(home: string, io: QuarantineIo = {}): LlamaQuarantineEntry[] {
  const readFile = io.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  try {
    const parsed = JSON.parse(readFile(llamaQuarantinePath(home))) as Partial<QuarantineFile>;
    if (parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(isEntry);
  } catch {
    // Missing (the common case), unreadable, or malformed. A quarantine
    // is an optimization over crashing — never let a bad file become the
    // reason the engine won't start.
    return [];
  }
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
 * Record that `backend`'s binary crashed. Replaces any existing entry for
 * the same backend and drops entries whose binary no longer matches, so
 * the file stays small and self-pruning.
 *
 * Returns the entry written, or null when the binary could not be
 * fingerprinted (it vanished mid-crash) — there is nothing meaningful to
 * pin the quarantine to in that case, and a stale-forever entry is worse
 * than none.
 */
export function recordLlamaQuarantine(
  home: string,
  input: { backend: LlamaBackend; binaryPath: string; signal: string; reason: string },
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
  };
  const kept = readLlamaQuarantine(home, io).filter((e) => e.backend !== input.backend);
  const path = llamaQuarantinePath(home);
  const mkdir = io.mkdir ?? ((p: string) => void mkdirSync(p, { recursive: true }));
  const writeFile = io.writeFile ?? ((p: string, data: string) => writeFileSync(p, data, 'utf8'));
  const file: QuarantineFile = { schemaVersion: SCHEMA_VERSION, entries: [...kept, entry] };
  mkdir(dirname(path));
  writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
  return entry;
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
