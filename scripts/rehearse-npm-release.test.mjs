import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  consumerCheckFailureSummary,
  consumerCheckReportPath,
  writeConsumerCheckReport,
} from './consumer-check-report.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const developmentSource =
  "export const GEZEL_VERSION = '0.0.0';\nexport const GEZEL_CONTENT_COMPAT = '0.0.0';\n";
const consumerFailure =
  'installed declarations failed\nconsumer.ts(1,1): error TS2307: missing dependency';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gezel-rehearsal-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'packages/core/src'), { recursive: true });
  for (const file of ['rehearse-npm-release.mjs', 'consumer-check-report.mjs', 'pnpm-cli.mjs']) {
    copyFileSync(join(scriptsDir, file), join(root, 'scripts', file));
  }
  writeFileSync(join(root, 'packages/core/package.json'), JSON.stringify({ version: '1.2.3' }));
  writeFileSync(join(root, 'packages/core/src/browser.ts'), developmentSource);
  writeFileSync(
    join(root, 'scripts/published-packages.mjs'),
    "export const publishedPackageNames = () => ['@bendyline/gezel'];\n",
  );
  writeFileSync(
    join(root, 'scripts/prepare-package.mjs'),
    `import { readFileSync, writeFileSync } from 'node:fs';
const source = 'src/browser.ts';
writeFileSync(source, readFileSync(source, 'utf8').replaceAll('0.0.0', process.argv[2]));
`,
  );
  writeFileSync(
    join(root, 'pnpm.mjs'),
    `if (process.argv.includes('pack')) {
  console.log('packed fixture');
} else {
  console.log('DTS Build success (cleanup fixture)');
  process.exitCode = Number(process.env.TEST_RESTORE_EXIT ?? 0);
}
`,
  );
  writeFileSync(
    join(root, 'scripts/check-package-consumers.mjs'),
    `import { writeConsumerCheckReport } from './consumer-check-report.mjs';
const failures = process.env.TEST_CONSUMER_EXIT === '0' ? [] : [${JSON.stringify(consumerFailure)}];
writeConsumerCheckReport(process.env.GEZEL_CONSUMER_REPORT_PATH, failures);
for (const failure of failures) console.error('FAIL ' + failure);
process.exitCode = Number(process.env.TEST_CONSUMER_EXIT ?? 1);
`,
  );
  return root;
}

function rehearse(root, extraEnv = {}) {
  // Merge both streams in the child to prove ordering after cleanup, without a shell.
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'process.stderr.write = process.stdout.write.bind(process.stdout); await import(process.argv[1]);',
      pathToFileURL(join(root, 'scripts/rehearse-npm-release.mjs')).href,
    ],
    {
      cwd: root,
      env: { ...process.env, GEZEL_PNPM_CLI: join(root, 'pnpm.mjs'), ...extraEnv },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
}

test('repeats the exact consumer failure after cleanup and retains its report', (t) => {
  const root = fixture(t);
  const report = join(root, '.cache/consumer-report.json');
  const result = rehearse(root, { GEZEL_CONSUMER_REPORT_PATH: report });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const cleanup = result.stdout.indexOf('DTS Build success (cleanup fixture)');
  assert.ok(cleanup > 0, result.stdout);
  const footer = result.stdout.slice(cleanup);
  assert.match(footer, /rehearsal: FAILED \(the core rebuild above was cleanup\)/);
  assert.ok(footer.includes(`FAIL ${consumerFailure}`), footer);
  assert.ok(footer.includes(`Consumer report: ${report}`), footer);
  assert.deepEqual(JSON.parse(readFileSync(report, 'utf8')).failures, [consumerFailure]);
  assert.equal(readFileSync(join(root, 'packages/core/src/browser.ts'), 'utf8'), developmentSource);
});

test('a passing consumer run still restores the development stamp and exits successfully', (t) => {
  const root = fixture(t);
  const report = join(root, '.cache/consumer-report.json');
  const result = rehearse(root, { GEZEL_CONSUMER_REPORT_PATH: report, TEST_CONSUMER_EXIT: '0' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /release candidate with core 1.2.3 passed/);
  assert.doesNotMatch(result.stdout, /rehearsal: FAILED/);
  assert.equal(readFileSync(join(root, 'packages/core/src/browser.ts'), 'utf8'), developmentSource);
});

test('reports a failed cleanup even when the consumer checks pass', (t) => {
  const root = fixture(t);
  const result = rehearse(root, {
    GEZEL_CONSUMER_REPORT_PATH: join(root, '.cache/consumer-report.json'),
    TEST_CONSUMER_EXIT: '0',
    TEST_RESTORE_EXIT: '9',
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /failed to restore the development core build \(9\)/);
  assert.doesNotMatch(result.stdout, /consumer check\(s\) failed/);
});

test('report paths are unique by default and malformed reports remain actionable', (t) => {
  const root = fixture(t);
  const first = consumerCheckReportPath(root, {});
  assert.notEqual(first, consumerCheckReportPath(root, {}));
  assert.match(consumerCheckFailureSummary(first), /Consumer failure report unavailable/);
  writeConsumerCheckReport(first, [consumerFailure]);
  assert.ok(consumerCheckFailureSummary(first).includes(consumerFailure));
  writeFileSync(first, JSON.stringify({ failures: [42] }));
  assert.match(consumerCheckFailureSummary(first), /invalid failure report/);
});
