import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { duckdbBinaryName, duckdbInstalledBinary } from '@bendyline/gezel/native';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DuckQueryError,
  DuckRunner,
  DuckUnavailableError,
  buildDuckPrelude,
  sqlLiteral,
} from './duck.js';
import { findRealDuckdb, hasRealDuckdb, makeFakeDuckdb } from './testing/duck-fixture.js';

let dir: string;
const priorBin = process.env.GEZEL_DUCKDB_BIN;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-duck-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  if (priorBin === undefined) delete process.env.GEZEL_DUCKDB_BIN;
  else process.env.GEZEL_DUCKDB_BIN = priorBin;
});

describe('buildDuckPrelude', () => {
  it('orders the lockdown so the seal comes last', () => {
    const sql = buildDuckPrelude({ allowedDirectories: ['/corpus'] });
    const lines = sql.split('\n');
    expect(lines.at(-1)).toBe('SET lock_configuration=true;');
    // allowed_directories must be established BEFORE external access is
    // withdrawn, or the scoping never takes effect.
    expect(sql.indexOf('allowed_directories')).toBeLessThan(sql.indexOf('enable_external_access'));
    expect(sql).toContain('autoinstall_known_extensions=false');
    expect(sql).toContain('autoload_known_extensions=false');
  });

  it('refuses an empty allow-list rather than defaulting to the whole disk', () => {
    expect(() => buildDuckPrelude({ allowedDirectories: [] })).toThrow(/must not be empty/);
  });

  it('escapes quotes in directory paths', () => {
    const sql = buildDuckPrelude({ allowedDirectories: ["/tmp/it's odd"] });
    expect(sql).toContain("'/tmp/it''s odd'");
    expect(sqlLiteral("a'b")).toBe("a''b");
  });

  it('clamps the thread count', () => {
    expect(buildDuckPrelude({ allowedDirectories: ['/c'], threads: 0 })).toContain(
      'SET threads=1;',
    );
    expect(buildDuckPrelude({ allowedDirectories: ['/c'], threads: 999 })).toContain(
      'SET threads=64;',
    );
  });
});

describe('DuckRunner — plumbing (fake CLI)', () => {
  const opts = { allowedDirectories: ['/corpus'] };

  it('reports an actionable error when no binary is configured', async () => {
    delete process.env.GEZEL_DUCKDB_BIN;
    // `fileExists: () => false` is what makes this hermetic: without it the
    // ladder would find a system DuckDB on any developer machine that has one
    // (brew, apt, install.duckdb.org) and the test would pass or fail
    // depending on the host rather than the code.
    const runner = new DuckRunner({ fileExists: () => false });
    expect(runner.available()).toBe(false);
    await expect(runner.runTrusted('SELECT 1', opts)).rejects.toBeInstanceOf(DuckUnavailableError);
    await expect(runner.runTrusted('SELECT 1', opts)).rejects.toMatchObject({
      isActionable: true,
    });
  });

  it('parses a JSON array result', async () => {
    const bin = await makeFakeDuckdb(join(dir, 'duckdb'), {
      stdout: '[{"n":1,"s":"ok"},{"n":2,"s":"two"}]',
    });
    const rows = await new DuckRunner({ binaryPath: bin }).runTrusted('SELECT 1', opts);
    expect(rows).toEqual([
      { n: 1, s: 'ok' },
      { n: 2, s: 'two' },
    ]);
  });

  it('treats empty output as no rows', async () => {
    const bin = await makeFakeDuckdb(join(dir, 'duckdb'), { stdout: '' });
    expect(await new DuckRunner({ binaryPath: bin }).runTrusted('SELECT 1', opts)).toEqual([]);
  });

  it('surfaces the engine message verbatim so a model can repair its SQL', async () => {
    const bin = await makeFakeDuckdb(join(dir, 'duckdb'), {
      stdout: '',
      stderr: 'Binder Error: Referenced column "rout" not found\nDid you mean "route"?',
      exitCode: 1,
    });
    const err = await new DuckRunner({ binaryPath: bin })
      .runTrusted('SELECT rout FROM t', opts)
      .catch((e) => e);
    expect(err).toBeInstanceOf(DuckQueryError);
    expect((err as DuckQueryError).engineMessage).toContain('Did you mean "route"?');
  });

  it('aborts on its budget and reports the elapsed budget, not a crash', async () => {
    const bin = await makeFakeDuckdb(join(dir, 'duckdb'), { sleepSeconds: 30, stdout: '[]' });
    const err = await new DuckRunner({ binaryPath: bin })
      .runTrusted('SELECT 1', { ...opts, timeoutMs: 300 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(DuckQueryError);
    expect((err as Error).message).toMatch(/exceeded its .*budget/);
  });

  it('scrubs GEZEL_* tokens and provider keys out of the child env', async () => {
    const envDumpPath = join(dir, 'env.txt');
    const bin = await makeFakeDuckdb(join(dir, 'duckdb'), { stdout: '[]', envDumpPath });
    process.env.GEZEL_TOKEN = 'super-secret-daemon-token';
    process.env.OPENAI_API_KEY = 'sk-should-not-leak';
    try {
      await new DuckRunner({ binaryPath: bin }).runTrusted('SELECT 1', opts);
      const dumped = await readFile(envDumpPath, 'utf8');
      expect(dumped).not.toContain('super-secret-daemon-token');
      expect(dumped).not.toContain('sk-should-not-leak');
      // PATH is on the allowlist and must survive, or the child cannot run.
      expect(dumped).toMatch(/^PATH=/m);
    } finally {
      delete process.env.GEZEL_TOKEN;
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('rejects non-JSON output instead of returning junk rows', async () => {
    const bin = await makeFakeDuckdb(join(dir, 'duckdb'), { stdout: 'not json at all' });
    await expect(new DuckRunner({ binaryPath: bin }).runTrusted('SELECT 1', opts)).rejects.toThrow(
      /not JSON/,
    );
  });
});

/**
 * The sandbox assertions. A fake CLI cannot answer these — only the pinned
 * engine can — so they are skipped where no binary is staged and run in CI,
 * which gets one from the native pipeline.
 *
 * The ATTACH case is the reason `statement-guard.ts` exists. Read its
 * expectation carefully before relaxing anything here.
 */
describe.runIf(hasRealDuckdb())('DuckRunner — sandbox (real engine)', () => {
  let corpus: string;
  let runner: DuckRunner;
  let opts: { allowedDirectories: string[]; timeoutMs: number };

  beforeEach(async () => {
    corpus = join(dir, 'corpus');
    await mkdtemp(join(tmpdir(), 'gezel-duck-unused-')).then((d) => rm(d, { recursive: true }));
    await writeFile(join(dir, 'placeholder'), '');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(corpus, { recursive: true });
    await writeFile(join(corpus, 't.csv'), 'a,b\n1,x\n2,y\n');
    runner = new DuckRunner({ binaryPath: findRealDuckdb() as string });
    opts = { allowedDirectories: [corpus], timeoutMs: 30_000 };
  });

  it('allows reads inside the corpus — the whole point of the allow-list', async () => {
    const rows = await runner.runTrusted(
      `SELECT * FROM read_csv('${join(corpus, 't.csv')}') ORDER BY a`,
      opts,
    );
    expect(rows).toEqual([
      { a: 1, b: 'x' },
      { a: 2, b: 'y' },
    ]);
  });

  it.each([
    ['a file outside the corpus', "SELECT * FROM read_csv('/etc/passwd', header=false) LIMIT 1"],
    ['a remote URL', "SELECT * FROM read_parquet('https://example.com/x.parquet')"],
    ['installing an extension', 'INSTALL httpfs'],
    ['copying data outside the corpus', "COPY (SELECT 1 AS x) TO '/tmp/gezel-duck-pwned.csv'"],
  ])('blocks %s', async (_label, sql) => {
    await expect(runner.runTrusted(sql, opts)).rejects.toBeInstanceOf(DuckQueryError);
  });

  it.each([
    ['re-enabling external access', 'SET enable_external_access=true'],
    ['widening the allow-list', "SET allowed_directories=['/']"],
  ])('refuses %s after the configuration is locked', async (_label, sql) => {
    const err = await runner.runTrusted(`${sql}; SELECT 1`, opts).catch((e) => e);
    expect(err).toBeInstanceOf(DuckQueryError);
    expect((err as DuckQueryError).engineMessage).toMatch(/locked/i);
  });

  it('DOES allow ATTACH inside the corpus — which is why the statement guard exists', async () => {
    // Not an endorsement: a regression assertion. `enable_external_access=false`
    // plus `lock_configuration=true` do NOT prevent a statement from creating a
    // writable database inside an allowed directory. Only the leading-keyword
    // allowlist in statement-guard.ts stops model-supplied SQL from doing this.
    // If this test ever starts failing because DuckDB closed the hole, that is
    // good news — but the guard stays, because it is the layer we control.
    const dbPath = join(corpus, 'attached.db');
    await runner.runTrusted(
      `ATTACH '${dbPath}' AS w; CREATE TABLE w.t AS SELECT 42 AS x; SELECT 1`,
      opts,
    );
    await expect(readFile(dbPath)).resolves.toBeDefined();
  });
});

describe('DuckRunner — binary discovery ladder', () => {
  const priorEnv = process.env.GEZEL_DUCKDB_BIN;
  const priorPath = process.env.PATH;
  afterEach(() => {
    if (priorEnv === undefined) delete process.env.GEZEL_DUCKDB_BIN;
    else process.env.GEZEL_DUCKDB_BIN = priorEnv;
    process.env.PATH = priorPath;
  });

  it('prefers the pinned build over a system DuckDB on PATH', () => {
    // The ordering is a security property, not a preference: the sandbox
    // prelude and the statement guard are contracts measured against the
    // pinned build, so an unknown-vintage PATH binary must never win.
    delete process.env.GEZEL_DUCKDB_BIN;
    process.env.PATH = '/usr/local/bin';
    const home = '/tmp/gezel-home';
    const pinned = duckdbInstalledBinary(home);
    const runner = new DuckRunner({
      home,
      fileExists: (p) => p === pinned || p === join('/usr/local/bin', duckdbBinaryName()),
    });
    expect(runner.resolvedBinaryProvenance()).toEqual({
      path: pinned,
      source: 'pinned',
      pinned: true,
    });
  });

  it('falls back to the DuckDB installer location, then PATH', () => {
    delete process.env.GEZEL_DUCKDB_BIN;
    process.env.PATH = '/usr/local/bin';
    const vendor = join(homedir(), '.duckdb', 'cli', 'latest', duckdbBinaryName());
    const onPath = join('/usr/local/bin', duckdbBinaryName());

    const viaInstaller = new DuckRunner({
      home: '/tmp/gezel-home',
      fileExists: (p) => p === vendor || p === onPath,
    });
    expect(viaInstaller.resolvedBinaryProvenance()).toMatchObject({
      source: 'duckdb-installer',
      pinned: false,
    });

    const viaPath = new DuckRunner({
      home: '/tmp/gezel-home',
      fileExists: (p) => p === onPath,
    });
    expect(viaPath.resolvedBinaryProvenance()).toMatchObject({
      path: onPath,
      source: 'path',
      pinned: false,
    });
  });

  it('lets GEZEL_DUCKDB_BIN override a present pinned build', () => {
    process.env.GEZEL_DUCKDB_BIN = '/opt/custom/duckdb';
    const runner = new DuckRunner({ home: '/tmp/gezel-home', fileExists: () => true });
    expect(runner.resolvedBinaryProvenance()).toMatchObject({
      path: '/opt/custom/duckdb',
      source: 'env',
    });
  });

  it('ignores empty PATH segments so a stray ./duckdb cannot win', () => {
    delete process.env.GEZEL_DUCKDB_BIN;
    process.env.PATH = `${delimiter}${delimiter}`;
    // Everything "exists" except the installer rung, so the only way to
    // resolve is through PATH — and every segment here is empty.
    const runner = new DuckRunner({
      fileExists: (p) => !p.includes(join('.duckdb', 'cli')),
    });
    expect(runner.resolvedBinaryProvenance()).toBeNull();
  });
});
