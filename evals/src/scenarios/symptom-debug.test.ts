import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACCEPT_MJS,
  ACCEPT_PATH,
  PAGINATE_MJS,
  PAGINATE_PATH,
  PKG_JSON,
  composeSymptomDebugVerdict,
  detectAcceptUntouched,
  verifySymptomDebugWorkspaceDir,
} from './symptom-debug.ts';

// The 1-line fix: the seed decodes a cursor as "last returned index"
// (+ 1) while the encode side stores "next index to return". Dropping
// the + 1 aligns the two conventions and all 8 cases pass.
const FIXED_PAGINATE_MJS = PAGINATE_MJS.replace(
  'decodeCursor(options.cursor) + 1',
  'decodeCursor(options.cursor)',
);

async function writeFixtureWorkspace(
  dir: string,
  paginateMjs: string,
  acceptMjs: string = ACCEPT_MJS,
): Promise<void> {
  for (const [path, content] of [
    ['package.json', PKG_JSON],
    [ACCEPT_PATH, acceptMjs],
    [PAGINATE_PATH, paginateMjs],
  ] as const) {
    const target = join(dir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

describe('symptom-debug: accept-untouched guard', () => {
  it('the seeded acceptance script reads as untouched', () => {
    expect(detectAcceptUntouched(ACCEPT_MJS)).toBe(true);
  });

  it('trailing-whitespace round-trips still read as untouched', () => {
    expect(detectAcceptUntouched(`${ACCEPT_MJS}\n`)).toBe(true);
  });

  it('a modified acceptance script reads as touched', () => {
    expect(detectAcceptUntouched(ACCEPT_MJS.replace("'a4'", "'a5'"))).toBe(false);
  });

  it('a missing acceptance script reads as touched', () => {
    expect(detectAcceptUntouched(null)).toBe(false);
  });
});

describe('symptom-debug: grader verdict vs the SEEDED state', () => {
  it('the seeded buggy paginate FAILS acceptance with verbatim CASE lines', async () => {
    const tmp = await mkdtemp(`${tmpdir()}/symptom-debug-seed-`);
    try {
      await writeFixtureWorkspace(tmp, PAGINATE_MJS);
      const verdict = await verifySymptomDebugWorkspaceDir(tmp);
      expect(verdict.ok).toBe(false);
      // accept.mjs is untouched; only the green acceptance run is missing.
      expect(verdict.signals).toContain('accept-untouched');
      expect(verdict.signals).not.toContain('paginate-changed');
      expect(verdict.missingRequiredSignals).toEqual(['accept-passes']);
      // The boundary-skip symptom shows up as the documented CASE lines.
      expect(verdict.accept).not.toBeNull();
      expect(verdict.accept?.ok).toBe(false);
      const cases = verdict.accept?.caseFailures ?? [];
      expect(cases.length).toBeGreaterThanOrEqual(3);
      expect(cases.some((l) => l.startsWith('CASE 3:'))).toBe(true);
      expect(cases.some((l) => l.startsWith('CASE 4:'))).toBe(true);
      expect(cases.join('\n')).toMatch(/expected .* got/);
      // CASE 3 names the skipped boundary item verbatim.
      expect(cases.find((l) => l.startsWith('CASE 3:'))).toContain('"a4"');
      expect(verdict.failReason).toMatch(/CASE 3:/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it('a modified accept.mjs fails the REQUIRED accept-untouched signal and is never executed', async () => {
    const tmp = await mkdtemp(`${tmpdir()}/symptom-debug-gamed-`);
    try {
      const gamedAccept = "console.log('ALL CASES PASS');\n";
      await writeFixtureWorkspace(tmp, FIXED_PAGINATE_MJS, gamedAccept);
      const verdict = await verifySymptomDebugWorkspaceDir(tmp);
      expect(verdict.ok).toBe(false);
      expect(verdict.missingRequiredSignals).toContain('accept-untouched');
      expect(verdict.accept).toBeNull();
      expect(verdict.failReason).toMatch(/was modified/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it('does not accept a paginate module that prints success and exits during import', async () => {
    const tmp = await mkdtemp(`${tmpdir()}/symptom-debug-process-exit-`);
    try {
      await writeFixtureWorkspace(
        tmp,
        "export function paginate() { return { items: [], nextCursor: null }; }\nconsole.log('ALL CASES PASS'); process.exit(0);\n",
      );
      const verdict = await verifySymptomDebugWorkspaceDir(tmp);
      expect(verdict.ok).toBe(false);
      expect(verdict.accept?.ok).toBe(false);
      expect(verdict.accept?.crashLine).toMatch(/hidden pagination probe/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('symptom-debug: grader verdict vs the REFERENCE solution', () => {
  it('the replace() actually changed the seed (fixture guard)', () => {
    expect(FIXED_PAGINATE_MJS).not.toBe(PAGINATE_MJS);
  });

  it('the one-line fix PASSES acceptance and the full verdict', async () => {
    const tmp = await mkdtemp(`${tmpdir()}/symptom-debug-ref-`);
    try {
      await writeFixtureWorkspace(tmp, FIXED_PAGINATE_MJS);
      const verdict = await verifySymptomDebugWorkspaceDir(tmp);
      expect(verdict.accept).not.toBeNull();
      expect(verdict.accept?.caseFailures ?? []).toEqual([]);
      expect(verdict.accept?.ok).toBe(true);
      expect(verdict.signals).toContain('accept-untouched');
      expect(verdict.signals).toContain('paginate-changed');
      expect(verdict.signals).toContain('accept-passes');
      expect(verdict.missingRequiredSignals).toEqual([]);
      expect(verdict.ok).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it('an equivalent fix on the encode side also passes (fix is not style-pinned)', async () => {
    // Encoding "last returned index" instead of "next index" is the other
    // legitimate way to reconcile the two cursor conventions.
    const encodeSideFix = PAGINATE_MJS.replace(
      'const nextCursor = nextIndex < items.length ? encodeCursor(nextIndex) : null;',
      'const nextCursor = nextIndex < items.length ? encodeCursor(nextIndex - 1) : null;',
    );
    expect(encodeSideFix).not.toBe(PAGINATE_MJS);
    const tmp = await mkdtemp(`${tmpdir()}/symptom-debug-alt-`);
    try {
      await writeFixtureWorkspace(tmp, encodeSideFix);
      const verdict = await verifySymptomDebugWorkspaceDir(tmp);
      expect(verdict.accept?.caseFailures ?? []).toEqual([]);
      expect(verdict.ok).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('symptom-debug: verdict composition edge cases', () => {
  it('a crashed acceptance run relays the crash line, not an empty failure', () => {
    const verdict = composeSymptomDebugVerdict({
      acceptText: ACCEPT_MJS,
      paginateText: 'export const paginate = null;\n',
      accept: {
        ok: false,
        exitCode: 1,
        caseFailures: [],
        crashLine: 'TypeError: paginate is not a function',
        timedOut: false,
      },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failReason).toMatch(/crashed/);
    expect(verdict.failReason).toMatch(/paginate is not a function/);
  });

  it('a deleted paginate.mjs is named in the failReason', () => {
    const verdict = composeSymptomDebugVerdict({
      acceptText: ACCEPT_MJS,
      paginateText: null,
      accept: null,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failReason).toMatch(/lib\/paginate\.mjs is missing/);
  });
});
