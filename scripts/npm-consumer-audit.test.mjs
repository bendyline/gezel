import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { blockingAdvisories, readAuditAllowlist } from './npm-consumer-audit.mjs';

const REPORT = {
  vulnerabilities: {
    'adm-zip': {
      severity: 'high',
      via: [
        {
          source: 1,
          title: 'adm-zip: Uncontrolled memory allocation (DoS)',
          url: 'https://github.com/advisories/GHSA-7q85-xj36-vmfc',
          severity: 'high',
        },
        {
          source: 2,
          title: 'adm-zip extraction follows destination symlinks',
          url: 'https://github.com/advisories/GHSA-vwc7-r8mq-g2x9',
          severity: 'moderate',
        },
      ],
    },
    '@bendyline/gezel-service': { severity: 'high', via: ['adm-zip'] },
  },
};

test('reports a high advisory once, under the package it affects', () => {
  const found = blockingAdvisories(REPORT, []);
  assert.deepEqual(
    found.map((a) => [a.id, a.pkg, a.severity]),
    [['GHSA-7q85-xj36-vmfc', 'adm-zip', 'high']],
  );
});

test('an unexpired allowlist entry accepts the advisory', () => {
  const allowlist = [{ id: 'GHSA-7q85-xj36-vmfc', reason: 'unreachable', expires: '2026-12-31' }];
  assert.deepEqual(blockingAdvisories(REPORT, allowlist, new Date('2026-10-01')), []);
});

test('an expired allowlist entry blocks again', () => {
  const allowlist = [{ id: 'GHSA-7q85-xj36-vmfc', reason: 'unreachable', expires: '2026-09-01' }];
  assert.equal(blockingAdvisories(REPORT, allowlist, new Date('2026-10-01')).length, 1);
});

test('the allowlist requires a reason and an expiry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gezel-audit-allowlist-'));
  try {
    const path = join(dir, 'allowlist.json');
    writeFileSync(path, JSON.stringify({ advisories: [{ id: 'GHSA-x' }] }));
    assert.throws(() => readAuditAllowlist(path), /reason, and an expires date/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the committed allowlist parses', () => {
  assert.ok(Array.isArray(readAuditAllowlist()));
});
