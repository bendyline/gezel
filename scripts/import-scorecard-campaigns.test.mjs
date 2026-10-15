import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { importCampaign } from './import-scorecard-campaigns.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gezel-scorecard-import-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), `${JSON.stringify(value)}\n`);
  };
  const campaign = {
    definition: {
      targets: [
        { id: 'cli', model: 'same-model', provider: 'cli' },
        { id: 'api', model: 'same-model', provider: 'api' },
      ],
      scenarios: [
        { suite: 'core', id: 'a' },
        { suite: 'core', id: 'b' },
      ],
    },
    identity: {
      source: { head: 'abcdef012345', sha256: 'a'.repeat(64) },
      service: { sha256: 'b'.repeat(64) },
      gilde: { version: '1.0.0', sha256: 'c'.repeat(64) },
      device: { label: 'Test', platform: 'linux', arch: 'arm64' },
      cliVersions: { cli: '1.0.0' },
      fixtures: { manifest: { 'mock/mock-server.ts': 'before', 'runner.ts': 'same' } },
    },
    rows: ['cli', 'api'].map((target) => {
      const result = {
        trialId: target,
        scenarioId: 'a',
        modelId: 'same-model',
        engine: target,
        success: target === 'api',
        startedAt: '2026-01-01T00:00:00Z',
        durationMs: 1000,
        runDir: join(root, target),
      };
      const score = {
        trialId: target,
        composite: target === 'api' ? 10 : 0,
        eligibility: { failureClass: target === 'api' ? 'pass' : 'model' },
      };
      write(`${target}/result.json`, result);
      write(`${target}/score.json`, score);
      return {
        cell: {
          id: `r1-${target}-a`,
          scenario: 'a',
          suite: 'core',
          model: 'same-model',
          provider: target,
          targetId: target,
          repetition: 1,
        },
        result,
        score,
      };
    }),
  };
  write('run/campaign.json', campaign);
  write('diagnosis.json', { finding: 'Failed TLS fixture initialization' });
  const spec = {
    runId: '2026-01-01-test',
    campaignRoot: 'run',
    count: 1,
    expectedTrials: 2,
    scope: 'subset',
    campaignSha256: createHash('sha256')
      .update(readFileSync(join(root, 'run/campaign.json')))
      .digest('hex'),
    note: 'Focused regression',
    models: { cli: { label: 'CLI', tier: 'cloud' }, api: { label: 'API', tier: 'cloud' } },
    classificationCorrections: [
      {
        cellId: 'r1-cli-a',
        failureClass: 'grader',
        reason: 'TLS fixture failure',
        evidence: ['diagnosis.json'],
      },
    ],
  };
  return { root, write, campaign, spec };
}

test('preserves engine identities, incomplete coverage, raw failures and explicit exclusions', (t) => {
  const f = fixture(t);
  const before = readFileSync(join(f.root, 'cli/result.json'));
  const { dataset, audit } = importCampaign(f.root, f.spec);
  assert.equal(dataset.results.length, 2);
  assert.deepEqual(
    dataset.results.map((r) => r.engine),
    ['cli', 'api'],
  );
  assert.deepEqual(dataset.results[0].cells, [
    { scenarioId: 'a', trials: 1, successes: 0, nonModelFailures: 1, medianDurationMs: 1000 },
    { scenarioId: 'b', trials: 0, successes: 0, nonModelFailures: 0 },
  ]);
  assert.equal(dataset.runs[0].scope, 'subset');
  assert.equal(dataset.runs[0].provenance.count, 1);
  assert.equal(audit.failedTrials, 1);
  assert.equal(audit.observations[0].originalFailureClass, 'model');
  assert.equal(audit.observations[0].publishedFailureClass, 'grader');
  assert.deepEqual(readFileSync(join(f.root, 'cli/result.json')), before);
});

function harnessRerun(f, identityChanges = {}) {
  const result = {
    trialId: 'cli-rerun',
    scenarioId: 'a',
    modelId: 'same-model',
    engine: 'cli',
    success: true,
    startedAt: '2026-01-01T01:00:00Z',
    durationMs: 2000,
    runDir: join(f.root, 'rerun-cli'),
  };
  const score = {
    trialId: 'cli-rerun',
    composite: 10,
    eligibility: { failureClass: 'pass' },
  };
  f.write('rerun-cli/result.json', result);
  f.write('rerun-cli/score.json', score);
  f.write('rerun/campaign.json', {
    definition: {
      targets: [f.campaign.definition.targets[0]],
      scenarios: [f.campaign.definition.scenarios[0]],
    },
    identity: {
      ...f.campaign.identity,
      source: { ...f.campaign.identity.source, sha256: 'd'.repeat(64) },
      fixtures: { manifest: { 'mock/mock-server.ts': 'after', 'runner.ts': 'same' } },
      ...identityChanges,
    },
    rows: [{ cell: f.campaign.rows[0].cell, result, score }],
  });
  const spec = { ...f.spec };
  delete spec.classificationCorrections;
  return {
    ...spec,
    excludedTrials: [
      { cellId: 'r1-cli-a', reason: 'Fixture never reached', evidence: ['diagnosis.json'] },
    ],
    harnessRerun: {
      campaignRoot: 'rerun',
      campaignSha256: createHash('sha256')
        .update(readFileSync(join(f.root, 'rerun/campaign.json')))
        .digest('hex'),
      expectedTrials: 1,
      harnessChanges: ['mock/mock-server.ts'],
    },
  };
}

test('drops excluded trials and fills them from a same-build harness rerun', (t) => {
  const f = fixture(t);
  const { dataset, audit } = importCampaign(f.root, harnessRerun(f));
  assert.deepEqual(dataset.results[0].cells[0], {
    scenarioId: 'a',
    trials: 1,
    successes: 1,
    nonModelFailures: 0,
    medianDurationMs: 2000,
  });
  assert.equal(dataset.runs[0].provenance.sourceHash, undefined);
  assert.equal(dataset.runs[0].provenance.serviceBuildHash, 'b'.repeat(64));
  assert.deepEqual(audit.excludedTrials, [{ cellId: 'r1-cli-a', reason: 'Fixture never reached' }]);
  assert.equal(audit.harnessRerun.trials, 1);
  assert.equal(audit.publishedTrials, 2);
  assert(!audit.observations.some((o) => o.trialId === 'cli'));
});

test('excludes without a rerun by leaving the cell unmeasured', (t) => {
  const f = fixture(t);
  const spec = harnessRerun(f);
  delete spec.harnessRerun;
  const { dataset, audit } = importCampaign(f.root, spec);
  assert.deepEqual(dataset.results[0].cells[0], {
    scenarioId: 'a',
    trials: 0,
    successes: 0,
    nonModelFailures: 0,
  });
  assert.equal(audit.publishedTrials, 1);
});

test('refuses a harness rerun that changed what the models ran against', (t) => {
  const f = fixture(t);
  assert.throws(
    () => importCampaign(f.root, harnessRerun(f, { service: { sha256: 'e'.repeat(64) } })),
    /different service build/,
  );
  assert.throws(
    () => importCampaign(f.root, harnessRerun(f, { cliVersions: { cli: '1.0.1' } })),
    /different cli version/,
  );
  const undeclared = harnessRerun(f);
  undeclared.harnessRerun.harnessChanges = ['runner.ts'];
  assert.throws(() => importCampaign(f.root, undeclared), /different harness files/);
  const passing = harnessRerun(f);
  passing.excludedTrials[0].cellId = 'r1-api-a';
  assert.throws(() => importCampaign(f.root, passing), /Cannot discard a passing/);
});

test('refuses changed journals and journals inconsistent with raw results', (t) => {
  const f = fixture(t);
  assert.throws(
    () => importCampaign(f.root, { ...f.spec, campaignSha256: '0'.repeat(64) }),
    /changed since review/,
  );
  f.write('cli/result.json', { ...f.campaign.rows[0].result, success: true });
  assert.throws(() => importCampaign(f.root, f.spec), /Journal and raw result disagree/);
});

test('refuses active campaigns and invalid or silent failure corrections', (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      importCampaign(f.root, {
        ...f.spec,
        classificationCorrections: [{ ...f.spec.classificationCorrections[0], evidence: [] }],
      }),
    /diagnosis and evidence/,
  );
  assert.throws(
    () =>
      importCampaign(f.root, {
        ...f.spec,
        classificationCorrections: [{ ...f.spec.classificationCorrections[0], cellId: 'r1-api-a' }],
      }),
    /Cannot discard a passing/,
  );
  f.write('run/campaign.lock', {});
  assert.throws(() => importCampaign(f.root, f.spec), /active/);
});
