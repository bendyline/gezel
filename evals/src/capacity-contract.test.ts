import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyTrial } from './failure-class.ts';
import { buildPreflightChecks } from './preflight.ts';
import { readCapacityDenialFromLog } from './runner.ts';

/**
 * Contract test for the capacity-denial log line (Theme E / E4).
 *
 * `capacityDenialLogLine(key, reason)` in
 * packages/service/src/providers/native/provider-pool.ts:40 is the SOURCE
 * OF TRUTH — it emits `capacity broker denied <key>: <reason>` at both
 * deny sites, where `reason` is CapacityBroker.denialReason's
 * `budget exhausted: would commit <N> against <M>`. Three eval-side
 * matchers depend on that exact shape (failure-class classifier, preflight
 * admission, and the strict runner reader). This test pins the coupling
 * from the eval side so an eval-side reword is caught in THIS package's
 * own test run — the service package can't see the eval regexes, so
 * without this the drift would only surface at trial time.
 *
 * If this fails after a deliberate change, update BOTH the eval regexes
 * and provider-pool.ts in lockstep.
 */
const KEY = 'llama-cpp/gemma4-e4b-q4#0';
const REASON = 'budget exhausted: would commit 103079215104 against 103079215104';
const CANONICAL_LINE = `capacity broker denied ${KEY}: ${REASON}`;

describe('capacity-denial line contract (eval side)', () => {
  it('the failure-class classifier reads it as infra / capacity-denial', () => {
    const c = classifyTrial({
      success: false,
      reason: 'trial ended: engine crashed',
      failureMode: 'crash',
      daemonLog: CANONICAL_LINE,
    });
    expect(c.failureClass).toBe('infra');
    expect(c.rule).toBe('capacity-denial');
  });

  it('preflight blocks admission on it (spawn/capacity check fails)', () => {
    const { checks, admitted } = buildPreflightChecks({
      result: { success: false, reason: 'engine crashed', failureMode: 'crash' },
      daemonLog: CANONICAL_LINE,
      genTokensPerSec: null,
      manifestHasProfiles: null,
      minGenTokensPerSec: 3,
    });
    expect(checks.spawn.ok).toBe(false);
    expect(checks.spawn.detail).toContain('capacity broker denied');
    expect(admitted).toBe(false);
  });

  it('the strict runner reader matches the full commit-against form', () => {
    // The runner reader is the strictest of the three — it requires the
    // full `…: budget exhausted: would commit N against M` shape.
    // (Reads a file path, so exercise it against a real daemon.log.)
    expect(readCapacityDenialFromLog(logPath)).toBe(CANONICAL_LINE);
  });
});

let logPath: string;
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-capacity-contract-'));
  logPath = join(dir, 'daemon.log');
  await writeFile(logPath, `some earlier line\n${CANONICAL_LINE}\ntrailing line\n`);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
