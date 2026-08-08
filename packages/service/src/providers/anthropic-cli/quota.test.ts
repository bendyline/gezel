import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeRateLimitsToQuotaBuckets,
  readClaudeQuotaSnapshot,
  writeClaudeQuotaCaptureFiles,
} from './quota.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-claude-quota-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('claudeRateLimitsToQuotaBuckets', () => {
  it('maps the documented subscriber windows and tolerates absent windows', () => {
    expect(
      claudeRateLimitsToQuotaBuckets({
        five_hour: { used_percentage: 12.5, resets_at: '2026-08-07T15:00:00Z' },
      }),
    ).toEqual([
      {
        name: 'five_hour',
        isUnlimited: false,
        limit: 100,
        used: 12.5,
        remaining: 87.5,
        remainingPercent: 87.5,
        overage: 0,
        resetDate: '2026-08-07T15:00:00.000Z',
      },
    ]);
  });
});

describe('Claude quota status-line capture', () => {
  it('persists only rate limits and reads unexpired windows back', async () => {
    const settingsPath = await writeClaudeQuotaCaptureFiles({
      runtimeDir: dir,
      projectId: 'project',
      sessionId: 'session',
      nodePath: process.execPath,
    });
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      statusLine: { command: string };
    };
    expect(settings.statusLine.command).toContain('quota-statusline.mjs');

    const scriptPath = join(dir, 'quota-statusline.mjs');
    const input = JSON.stringify({
      session_id: 'must-not-be-saved',
      cwd: '/private/workspace',
      rate_limits: {
        five_hour: { used_percentage: 40, resets_at: '2099-01-01T00:00:00Z' },
        seven_day: { used_percentage: 75, resets_at: '2099-01-02T00:00:00Z' },
      },
    });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath], { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`capture script exited ${code}: ${stderr}`));
      });
      child.stdin.end(input);
    });

    const raw = await readFile(join(dir, 'quota.json'), 'utf8');
    expect(raw).not.toContain('must-not-be-saved');
    expect(raw).not.toContain('/private/workspace');
    const snapshot = await readClaudeQuotaSnapshot(dir, Date.parse('2026-08-07T00:00:00Z'));
    expect(snapshot?.buckets).toMatchObject([
      { name: 'five_hour', used: 40 },
      { name: 'seven_day', used: 75 },
    ]);
  });
  it('ignores a missing snapshot', async () => {
    expect(await readClaudeQuotaSnapshot(dir)).toBeNull();
  });
});
