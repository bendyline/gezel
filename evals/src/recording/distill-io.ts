import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ChatSession,
  type DistillScreenshotIndexEntry,
  type DistillTaskNotes,
  type HistoryEvent,
  type RunRecordingActor,
  type RunRecordingTrial,
  distillRunRecording,
} from '@bendyline/gezel';

/**
 * File-loading shell around core's pure `distillRunRecording`: read a
 * finished run dir's capture (sessions/, history.jsonl, recording/*) and
 * write `recording/transcript.json`.
 *
 * Works at two fidelities on purpose:
 * - a fresh trial (finalize calls this always-on) has task notes, actors,
 *   per-tool-call timestamps, and delegation edges;
 * - an OLD run dir (backfill via `bin/distill-recording.ts`) has none of
 *   those — the distiller degrades to message-level timing and
 *   tool-name-heuristic edges, which is still a playable timeline.
 */
export async function distillRunDir(
  runDir: string,
  opts?: { trial?: RunRecordingTrial; log?: (line: string) => void },
): Promise<{ scenes: number; bytes: number } | null> {
  const log = opts?.log ?? (() => {});

  const sessions: ChatSession[] = [];
  const sessionsDir = join(runDir, 'sessions');
  if (existsSync(sessionsDir)) {
    for (const file of await readdir(sessionsDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        sessions.push(JSON.parse(await readFile(join(sessionsDir, file), 'utf8')) as ChatSession);
      } catch (err) {
        log(`[distill] skipped unreadable session ${file}: ${String(err)}`);
      }
    }
  }
  if (sessions.length === 0) {
    log('[distill] no sessions captured; nothing to distill');
    return null;
  }

  const historyEvents: HistoryEvent[] = [];
  const historyPath = join(runDir, 'history.jsonl');
  if (existsSync(historyPath)) {
    for (const line of (await readFile(historyPath, 'utf8')).split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        historyEvents.push(JSON.parse(line) as HistoryEvent);
      } catch {
        // A torn tail line on a killed trial is expected; skip it.
      }
    }
  }

  const taskNotes = await readJsonIfPresent<DistillTaskNotes[]>(
    join(runDir, 'recording', 'task-notes.json'),
  );
  const actors = await readJsonIfPresent<RunRecordingActor[]>(
    join(runDir, 'recording', 'actors.json'),
  );
  const screenshotIndex = await readJsonIfPresent<Array<Record<string, unknown>>>(
    join(runDir, 'recording', 'screenshots', 'index.json'),
  );
  const screenshots: DistillScreenshotIndexEntry[] | undefined = screenshotIndex
    ?.filter((entry) => typeof entry.sourcePath === 'string' && typeof entry.png === 'string')
    .map((entry) => ({
      sourcePath: entry.sourcePath as string,
      png: entry.png as string,
      ...(typeof entry.sourceStore === 'string' ? { sourceStore: entry.sourceStore } : {}),
      ...(typeof entry.width === 'number' ? { width: entry.width } : {}),
      ...(typeof entry.height === 'number' ? { height: entry.height } : {}),
    }));

  const trial = opts?.trial ?? (await trialFromResultJson(runDir));

  const recording = distillRunRecording({
    sessions,
    ...(historyEvents.length > 0 ? { historyEvents } : {}),
    ...(taskNotes ? { taskNotes } : {}),
    ...(actors ? { actors } : {}),
    ...(screenshots && screenshots.length > 0 ? { screenshots } : {}),
    ...(trial ? { trial } : {}),
  });
  const serialized = JSON.stringify(recording, null, 2);
  await mkdir(join(runDir, 'recording'), { recursive: true });
  await writeFile(join(runDir, 'recording', 'transcript.json'), serialized);
  const stats = { scenes: recording.scenes.length, bytes: Buffer.byteLength(serialized) };
  log(`[distill] wrote recording/transcript.json (${stats.scenes} scenes, ${stats.bytes} bytes)`);
  return stats;
}

async function readJsonIfPresent<T>(path: string): Promise<T | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function trialFromResultJson(runDir: string): Promise<RunRecordingTrial | undefined> {
  const result = await readJsonIfPresent<Record<string, unknown>>(join(runDir, 'result.json'));
  if (!result) return undefined;
  const trialId = result.trialId;
  const scenarioId = result.scenarioId;
  const modelId = result.modelId;
  const startedAt = result.startedAt;
  if (
    typeof trialId !== 'string' ||
    typeof scenarioId !== 'string' ||
    typeof modelId !== 'string' ||
    typeof startedAt !== 'string'
  ) {
    return undefined;
  }
  return {
    trialId,
    scenarioId,
    modelId,
    startedAt,
    ...(typeof result.durationMs === 'number' ? { durationMs: result.durationMs } : {}),
    ...(typeof result.success === 'boolean' ? { success: result.success } : {}),
    ...(typeof result.reason === 'string' ? { reason: result.reason } : {}),
  };
}
