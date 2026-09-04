import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRunRecording } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { distillRunDir } from './distill-io.ts';

describe('distillRunDir', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'gezel-distill-'));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('loads a captured run dir and writes a schema-valid transcript', async () => {
    const at = (s: number) => new Date(Date.UTC(2026, 8, 1, 10, 0, s)).toISOString();
    await mkdir(join(runDir, 'sessions'), { recursive: true });
    await mkdir(join(runDir, 'recording', 'screenshots'), { recursive: true });
    await writeFile(
      join(runDir, 'sessions', 'ada--s1.json'),
      JSON.stringify({
        id: 's1',
        gezelId: 'ada',
        projectId: 'default',
        createdAt: at(0),
        lastActivityAt: at(60),
        messages: [
          { role: 'user', content: 'Build the report.', at: at(0) },
          {
            role: 'assistant',
            content: 'Done — wrote index.html.',
            at: at(50),
            toolCalls: [
              {
                name: 'write_file',
                at: at(40),
                durationMs: 200,
                success: true,
                path: 'index.html',
              },
            ],
          },
        ],
      }),
    );
    await writeFile(
      join(runDir, 'history.jsonl'),
      [
        JSON.stringify({
          id: 'h1',
          at: at(41),
          kind: 'workspace.write',
          gezelId: 'ada',
          summary: 'Wrote index.html',
          details: { path: 'index.html', bytes: 512 },
        }),
        // Torn tail line, as a killed trial leaves behind.
        '{"id":"h2","at":"2026-',
      ].join('\n'),
    );
    await writeFile(
      join(runDir, 'recording', 'task-notes.json'),
      JSON.stringify([
        {
          ref: 'default/1',
          projectId: 'default',
          num: 1,
          notes: [{ at: at(45), author: 'ada', text: 'Report shipped.' }],
        },
      ]),
    );
    await writeFile(
      join(runDir, 'recording', 'actors.json'),
      JSON.stringify([{ id: 'ada', name: 'Ada', role: 'Meester', kind: 'gezel', meester: true }]),
    );
    await writeFile(
      join(runDir, 'recording', 'screenshots', 'index.json'),
      JSON.stringify([
        {
          sourceStore: 'workspace',
          sourcePath: 'index.html',
          png: '00-index.png',
          width: 900,
          height: 720,
        },
      ]),
    );
    await writeFile(
      join(runDir, 'result.json'),
      JSON.stringify({
        trialId: 't1',
        scenarioId: 'demo',
        modelId: 'mock',
        startedAt: at(0),
        durationMs: 60_000,
        success: true,
        reason: 'done',
      }),
    );

    const stats = await distillRunDir(runDir);
    expect(stats).not.toBeNull();
    expect(stats!.scenes).toBeGreaterThan(0);

    const raw = JSON.parse(
      await readFile(join(runDir, 'recording', 'transcript.json'), 'utf8'),
    ) as unknown;
    const parsed = parseRunRecording(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.recording.trial).toMatchObject({ trialId: 't1', scenarioId: 'demo' });
    const artifact = parsed.recording.scenes.find((scene) => scene.kind === 'artifact-produced');
    expect(artifact).toMatchObject({
      path: 'index.html',
      screenshotRef: 'screenshots/00-index.png',
    });
    expect(parsed.recording.scenes.some((scene) => scene.kind === 'note')).toBe(true);
    expect(parsed.recording.actors.map((actor) => actor.id).sort()).toEqual(['ada', 'user']);
  });

  it('returns null (and writes nothing) when no sessions were captured', async () => {
    expect(await distillRunDir(runDir)).toBeNull();
  });
});
