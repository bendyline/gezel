import { describe, expect, it } from 'vitest';
import { codexRateLimitsToQuotaBuckets, readCodexQuotaBuckets } from './quota.js';

describe('codexRateLimitsToQuotaBuckets', () => {
  it('maps primary and secondary percentage windows', () => {
    const resetAt = 1_786_118_400;
    expect(
      codexRateLimitsToQuotaBuckets({
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 24.5, windowDurationMins: 300, resetsAt: resetAt },
          secondary: { usedPercent: 61, windowDurationMins: 10_080, resetsAt: resetAt },
        },
      }),
    ).toEqual([
      {
        name: 'five_hour',
        isUnlimited: false,
        limit: 100,
        used: 24.5,
        remaining: 75.5,
        remainingPercent: 75.5,
        overage: 0,
        resetDate: new Date(resetAt * 1_000).toISOString(),
      },
      {
        name: 'seven_day',
        isUnlimited: false,
        limit: 100,
        used: 61,
        remaining: 39,
        remainingPercent: 39,
        overage: 0,
        resetDate: new Date(resetAt * 1_000).toISOString(),
      },
    ]);
  });

  it('prefers named rate-limit groups and disambiguates matching windows', () => {
    const buckets = codexRateLimitsToQuotaBuckets({
      rateLimitsByLimitId: {
        codex: { limitName: 'Codex', primary: { usedPercent: 10, windowDurationMins: 300 } },
        review: {
          limitName: 'Code Review',
          primary: { usedPercent: 20, windowDurationMins: 300 },
        },
      },
    });
    expect(buckets.map((bucket) => bucket.name)).toEqual(['five_hour', 'code_review_five_hour']);
  });
});

describe('readCodexQuotaBuckets', () => {
  it('performs the initialize handshake before requesting account limits', async () => {
    const program = String.raw`
      let buffer = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) {
            newline = buffer.indexOf('\n');
            continue;
          }
          const message = JSON.parse(line);
          if (message.id === 0 && message.method === 'initialize') {
            process.stdout.write(JSON.stringify({ id: 0, result: {} }) + '\n');
          }
          if (message.id === 1 && message.method === 'account/rateLimits/read') {
            process.stdout.write(JSON.stringify({
              id: 1,
              result: { rateLimits: { primary: { usedPercent: 35, windowDurationMins: 300 } } }
            }) + '\n');
          }
          newline = buffer.indexOf('\n');
        }
      });
    `;
    const buckets = await readCodexQuotaBuckets({
      binaryPath: process.execPath,
      args: ['-e', program],
      timeoutMs: 2_000,
    });
    expect(buckets).toMatchObject([{ name: 'five_hour', used: 35, remaining: 65 }]);
  });
});
