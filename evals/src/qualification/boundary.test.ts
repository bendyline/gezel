import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GezelClient } from '@bendyline/gezel-client/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QualificationBoundary } from './boundary.ts';
import { resolveQualificationFlags } from './config.ts';

describe('qualification intervention boundary', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qualification-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('blocks sends, workspace repairs and raw uploads before HTTP, while allowing reads', async () => {
    const boundary = new QualificationBoundary(dir, 'runtime');
    const fetcher = vi.fn(async () => Response.json({ sessions: [] }));
    const observed = boundary.observeFetch(fetcher);
    const client = new GezelClient({
      baseUrl: 'http://localhost',
      token: 'secret-key',
      fetch: observed,
    });
    await client.listChatSessions();
    await expect(client.sendChatMessage('builder', { message: 'hidden answer' })).rejects.toThrow(
      'blocked evaluator',
    );
    await expect(
      observed('http://localhost/api/projects/default/workspace/a', {
        method: 'PUT',
        body: 'repair',
      }),
    ).rejects.toThrow('blocked evaluator');
    await expect(
      observed(
        new Request('http://localhost/api/unknown-new-tool', { method: 'POST', body: 'repair' }),
      ),
    ).rejects.toThrow('blocked evaluator');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(boundary.interventions.filter((e) => e.status === 'blocked')).toHaveLength(3);
    expect(await readFile(join(dir, 'interventions.jsonl'), 'utf8')).not.toMatch(
      /secret-key|hidden answer/,
    );
  });

  it('keeps concurrent fixture, user and evaluator sources separate across awaits', async () => {
    const boundary = new QualificationBoundary(dir, 'harness');
    const observed = boundary.observeFetch(async () => Response.json({}));
    await Promise.all(
      ['fixture', 'user-request', 'simulated-user', 'evaluator'].map((source) =>
        boundary.run(source as 'fixture', source, async () => {
          await Promise.resolve();
          await observed('http://localhost/api/sessions/a/send', {
            method: 'POST',
            body: JSON.stringify({ message: source }),
          });
        }),
      ),
    );
    expect(
      boundary.interventions
        .filter((e) => e.status === 'delivered')
        .map((e) => e.source)
        .sort(),
    ).toEqual(['evaluator', 'fixture', 'simulated-user', 'user-request']);
  });

  it('records unsuccessful HTTP mutations as failed, never delivered', async () => {
    const boundary = new QualificationBoundary(dir, 'runtime');
    await boundary.run('user-request', 'initial', () =>
      boundary.observeFetch(async () => new Response(null, { status: 403 }))(
        'http://localhost/api/chat',
        { method: 'POST' },
      ),
    );
    expect(boundary.interventions.map((e) => e.status)).toEqual(['attempted', 'failed']);
  });
});

describe('qualification flags', () => {
  it('is opt-in, with no automatic answers and a bounded completion wait', async () => {
    expect(await resolveQualificationFlags({})).toBeUndefined();
    expect(await resolveQualificationFlags({ qualification: true })).toEqual({
      userSimulation: 'disabled',
      userScript: [],
      completionTimeoutMs: 120000,
    });
  });
  const invalidFlags: Array<Record<string, string | boolean>> = [
    { 'user-simulation': 'disabled' },
    { qualification: true, 'user-simulation': 'guess' },
    { qualification: true, 'user-simulation': 'scripted' },
    { qualification: true, 'completion-timeout': '0s' },
    { qualification: true, 'completion-timeout': true },
  ];
  it.each(invalidFlags)('rejects invalid treatment %j', async (flags) => {
    await expect(resolveQualificationFlags(flags)).rejects.toThrow();
  });
});
