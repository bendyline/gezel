import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function consumerCheckReportPath(repoRoot, env = process.env) {
  return resolve(
    repoRoot,
    env.GEZEL_CONSUMER_REPORT_PATH ??
      `.cache/consumer-checks/${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.json`,
  );
}

export function writeConsumerCheckReport(path, failures) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ finishedAt: new Date().toISOString(), failures }, null, 2)}\n`,
    'utf8',
  );
}

/** Printed after rehearsal restores core, so a successful cleanup cannot hide the failure. */
export function consumerCheckFailureSummary(path) {
  try {
    const { failures } = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(failures) || failures.some((failure) => typeof failure !== 'string')) {
      throw new Error('invalid failure report');
    }
    return [
      ...(failures.length > 0
        ? [
            `${failures.length} consumer check(s) failed:`,
            ...failures.map((failure) => `  FAIL ${failure}`),
          ]
        : []),
      `Consumer report: ${path}`,
    ].join('\n');
  } catch (error) {
    return `Consumer failure report unavailable: ${path} (${error.message})`;
  }
}
