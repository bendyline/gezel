import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexStore } from '../index-store/index-store.js';
import { scanCode, shannonEntropy } from './code-patterns.js';
import { packageNameOf } from './scan.js';

describe('scanCode (built-in pattern scanner)', () => {
  it('flags a SQL injection sink built from a template literal', () => {
    const findings = scanCode(
      'const rows = await db.query(`SELECT * FROM u WHERE id=${req.params.id}`);',
    );
    const cats = findings.map((f) => f.category);
    expect(cats).toContain('injection');
    // The request-input read is also surfaced as a taint source.
    expect(cats).toContain('taint-source');
  });

  it('flags eval and command execution', () => {
    expect(scanCode('eval(userInput)').some((f) => f.ruleId === 'sink.eval')).toBe(true);
    expect(
      scanCode("child_process.exec('ls ' + name)").some((f) => f.category === 'command-injection'),
    ).toBe(true);
  });

  it('flags exec across its child_process spellings', () => {
    const flagged = (src: string) => scanCode(src).some((f) => f.ruleId === 'sink.command-exec');
    expect(flagged("exec('ls ' + name)")).toBe(true);
    expect(flagged("execSync('ls ' + name)")).toBe(true);
    expect(flagged("cp.exec('convert ' + file)")).toBe(true);
    expect(flagged("childProcess.exec('ls')")).toBe(true);
    expect(flagged("cp2.execSync('ls')")).toBe(true);
  });

  it('does not flag non-child_process exec receivers (regex, sqlite, statements)', () => {
    const flagged = (src: string) => scanCode(src).some((f) => f.ruleId === 'sink.command-exec');
    expect(flagged('const m = myRe.exec(line);')).toBe(false);
    expect(flagged('db.exec(sql);')).toBe(false);
    expect(flagged('stmt.exec();')).toBe(false);
    expect(flagged('const m = /x/.exec(s);')).toBe(false);
    expect(flagged('handle?.exec(query);')).toBe(false);
    expect(flagged('myexec(cmd);')).toBe(false);
  });

  it('flags a hardcoded credential and reports a 1-based line', () => {
    const src = 'const cfg = {};\nconst apiKey = "abcd1234efgh5678ijkl";\n';
    const hit = scanCode(src).find((f) => f.category === 'secret');
    expect(hit).toBeTruthy();
    expect(hit?.line).toBe(2);
  });

  it('never stores a raw high-entropy secret value in evidence', () => {
    const secret = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    const hit = scanCode(`const k = "${secret}";`).find(
      (f) => f.ruleId === 'secret.aws-access-key',
    );
    expect(hit).toBeTruthy();
    expect(hit?.evidence ?? '').not.toContain(secret);
  });

  it('does not flag credential shapes inside comment lines', () => {
    const findings = scanCode('// password = "hunter2placeholder"');
    expect(findings.some((f) => f.category === 'secret')).toBe(false);
  });

  it('entropy: real key material scores higher than prose', () => {
    expect(shannonEntropy('aGVsbG8gd29ybGQgYmFzZTY0IGJsb2I=')).toBeGreaterThan(
      shannonEntropy('the quick brown fox'),
    );
  });
});

describe('packageNameOf', () => {
  it('resolves scoped, subpath, builtin, and relative specifiers', () => {
    expect(packageNameOf('react')).toBe('react');
    expect(packageNameOf('lodash/merge')).toBe('lodash');
    expect(packageNameOf('@scope/pkg/sub')).toBe('@scope/pkg');
    expect(packageNameOf('node:fs')).toBeNull();
    expect(packageNameOf('fs')).toBeNull();
    expect(packageNameOf('./local')).toBeNull();
  });
});

describe('IndexStore security tables', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-sec-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function open(): Promise<IndexStore> {
    const s = await IndexStore.open(join(dir, 'index.db'), {
      collectionId: 'p1',
      kind: 'workspace',
      rootPath: dir,
    });
    expect(s).not.toBeNull();
    return s as IndexStore;
  }

  it('round-trips built-in findings and separates tool findings by source', async () => {
    const store = await open();
    store.putBuiltinFindings('src/a.ts', 'h1', [
      { line: 3, ruleId: 'sink.eval', category: 'injection', severity: 'high', title: 'eval' },
    ]);
    store.replaceToolFindings('semgrep', [
      {
        filePath: 'src/b.ts',
        line: 9,
        ruleId: 'semgrep.x',
        category: 'ssrf',
        severity: 'critical',
        title: 'ssrf',
      },
    ]);

    const all = store.securityFindings({});
    expect(all).toHaveLength(2);
    // critical sorts before high.
    expect(all[0]?.severity).toBe('critical');

    // Re-scanning file a must NOT wipe the semgrep finding on file b.
    store.putBuiltinFindings('src/a.ts', 'h2', []);
    expect(store.securityFindings({ source: 'semgrep' })).toHaveLength(1);
    expect(store.securityFindings({ source: 'builtin' })).toHaveLength(0);

    const counts = store.securityFindingCounts();
    expect(counts.total).toBe(1);
    expect(counts.bySource.semgrep).toBe(1);
    store.close();
  });

  it('keeps finding lifecycle through re-scans and reopens a later regression', async () => {
    const store = await open();
    const finding = {
      line: 3,
      ruleId: 'sink.eval',
      category: 'injection',
      severity: 'high' as const,
      title: 'eval',
    };
    const fingerprint = 'sink.eval:src/a.ts:3';
    store.putBuiltinFindings('src/a.ts', 'h1', [finding]);

    expect(store.setSecurityFindingStatus(fingerprint, 'in_progress', 'p1/1')).toBe(true);
    expect(store.securityFindingByFingerprint(fingerprint)).toMatchObject({
      status: 'in_progress',
      taskRef: 'p1/1',
    });
    expect(store.resolveSecurityFindingsForTask('p1/1')).toBe(1);
    expect(store.securityFindings()).toHaveLength(0);
    expect(store.securityFindingCounts().total).toBe(0);

    // Same live fingerprint remains resolved when the scanner rewrites rows.
    store.putBuiltinFindings('src/a.ts', 'h2', [finding]);
    expect(store.securityFindings()).toHaveLength(0);

    // Once the scanner proves it gone, prune the lifecycle. A later recurrence
    // is a new open regression rather than an indefinitely hidden finding.
    store.putBuiltinFindings('src/a.ts', 'h3', []);
    store.putBuiltinFindings('src/a.ts', 'h4', [finding]);
    expect(store.securityFindings()).toMatchObject([{ status: 'open', fingerprint }]);
    store.close();
  });

  it('round-trips the dependency inventory', async () => {
    const store = await open();
    store.replaceDependencies([
      { name: 'react', ecosystem: 'npm', version: '18.0.0', direct: true, license: 'MIT' },
      {
        name: 'lodash',
        ecosystem: 'npm',
        version: '4.17.20',
        direct: true,
        advisoryIds: ['GHSA-x'],
        maxSeverity: 'high',
      },
    ]);
    const deps = store.dependencies();
    expect(deps).toHaveLength(2);
    // Advisory-bearing package sorts first.
    expect(deps[0]?.name).toBe('lodash');
    expect(deps[0]?.advisoryIds).toEqual(['GHSA-x']);
    expect(deps[1]?.license).toBe('MIT');
    store.close();
  });
});
