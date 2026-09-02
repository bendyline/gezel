import { existsSync } from 'node:fs';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RUN_RECORDING_SCHEMA_VERSION, type RunRecordingManifest } from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client/node';
import type { ChatEventRecorderStats } from './recorder.ts';

/**
 * Recording-side captures that need the daemon still alive — run from
 * `captureFinalState` (before `shutdownTrialDaemon`). Everything here is
 * data the trial-home deletion would otherwise destroy:
 *
 * - task notes (read live at grading time today, then lost with the home)
 * - completed-task records (`tasks/history/` — live tasks are in state.json,
 *   completed ones have already moved here)
 * - the actor roster with poppetje STRUCTS (the visual identity the movie
 *   layer renders; captured as data, not SVG — the renderer is a React
 *   component in the UI package, and consumers have an initials fallback)
 *
 * Same stance as the rest of capture: every section is best-effort, logs
 * `[recording]`, and never affects the verdict.
 */

export interface RecordingCaptureStatus {
  taskNotes: string;
  taskHistory: string;
  actors: string;
}

export async function captureRecordingState(args: {
  client: GezelClient;
  trialHome: string;
  runDir: string;
  log: (line: string) => void;
}): Promise<RecordingCaptureStatus> {
  const { client, trialHome, runDir, log } = args;
  const recordingDir = join(runDir, 'recording');
  await mkdir(recordingDir, { recursive: true });
  const status: RecordingCaptureStatus = {
    taskNotes: 'ok',
    taskHistory: 'ok',
    actors: 'ok',
  };

  // Task notes, per task across every project. The tasks list carries the
  // (projectId, num) pairs; notes come one HTTP call per task — fine at
  // trial scale (tens of tasks, loopback).
  try {
    const { tasks } = await client.listTasks();
    const notes: Array<{
      ref: string;
      projectId: string;
      num: number;
      title?: string;
      craftbookId?: string;
      notes: unknown[];
    }> = [];
    for (const task of tasks) {
      try {
        const res = await client.listTaskNotes(task.projectId, task.num);
        notes.push({
          ref: task.ref,
          projectId: task.projectId,
          num: task.num,
          ...(task.title ? { title: task.title } : {}),
          ...(task.craftbook?.id ? { craftbookId: task.craftbook.id } : {}),
          notes: res.notes,
        });
      } catch (err) {
        log(
          `[recording] task notes for ${task.ref} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    await writeFile(join(recordingDir, 'task-notes.json'), JSON.stringify(notes, null, 2));
    log(`[recording] captured notes for ${notes.length} task(s)`);
  } catch (err) {
    status.taskNotes = `failed: ${err instanceof Error ? err.message : String(err)}`;
    log(`[recording] task-notes capture failed: ${status.taskNotes}`);
  }

  // Completed-task records — live tasks are already in state.json, but a
  // completed task's record has moved to tasks/history/ and would vanish
  // with the trial home.
  try {
    const historySrc = join(trialHome, 'tasks', 'history');
    if (existsSync(historySrc)) {
      await cp(historySrc, join(recordingDir, 'task-history'), { recursive: true });
      log('[recording] captured completed-task history');
    } else {
      status.taskHistory = 'absent';
    }
  } catch (err) {
    status.taskHistory = `failed: ${err instanceof Error ? err.message : String(err)}`;
    log(`[recording] task-history capture failed: ${status.taskHistory}`);
  }

  // Actor roster with poppetje structs.
  try {
    const { gezels } = await client.listGezels();
    const config = await client.getConfig().catch(() => null);
    const meesterId = (config as { meesterGezelId?: string } | null)?.meesterGezelId;
    const actors: unknown[] = [];
    for (const gezel of gezels) {
      let poppetje: unknown;
      try {
        poppetje = (await client.getGezelPoppetje(gezel.id)).poppetje;
      } catch {
        // A gezel without a resolved figure still belongs in the roster.
      }
      actors.push({
        id: gezel.id,
        name: gezel.name,
        ...(gezel.role ? { role: gezel.role } : {}),
        kind: 'gezel',
        ...(meesterId === gezel.id ? { meester: true } : {}),
        ...(poppetje ? { poppetje } : {}),
      });
    }
    await writeFile(join(recordingDir, 'actors.json'), JSON.stringify(actors, null, 2));
    log(`[recording] captured ${actors.length} actor(s)`);
  } catch (err) {
    status.actors = `failed: ${err instanceof Error ? err.message : String(err)}`;
    log(`[recording] actors capture failed: ${status.actors}`);
  }

  return status;
}

/** Written at finalize; the durable index of what this run's recording holds. */
export async function writeRecordingManifest(args: {
  runDir: string;
  trialId: string;
  scenarioId: string;
  modelId: string;
  startedAt?: string;
  finishedAt?: string;
  chatEvents?: ChatEventRecorderStats;
  capture?: Record<string, string>;
  log: (line: string) => void;
}): Promise<void> {
  const recordingDir = join(args.runDir, 'recording');
  await mkdir(recordingDir, { recursive: true });
  const files: Record<string, string> = {};
  const known: Array<[string, string]> = [
    ['chatEvents', 'recording/chat-events.jsonl'],
    ['taskNotes', 'recording/task-notes.json'],
    ['taskHistory', 'recording/task-history'],
    ['actors', 'recording/actors.json'],
    ['transcript', 'recording/transcript.json'],
    ['screenshots', 'recording/screenshots'],
  ];
  for (const [key, rel] of known) {
    if (existsSync(join(args.runDir, rel))) files[key] = rel;
  }
  const manifest: RunRecordingManifest = {
    schemaVersion: RUN_RECORDING_SCHEMA_VERSION,
    trialId: args.trialId,
    scenarioId: args.scenarioId,
    modelId: args.modelId,
    ...(args.startedAt ? { startedAt: args.startedAt } : {}),
    ...(args.finishedAt ? { finishedAt: args.finishedAt } : {}),
    ...(Object.keys(files).length > 0 ? { files } : {}),
    ...(args.chatEvents
      ? {
          chatEvents: {
            lines: args.chatEvents.lines,
            coalescedDeltas: args.chatEvents.coalescedDeltas,
            ...(args.chatEvents.gaps.length > 0 ? { gaps: args.chatEvents.gaps } : {}),
            ...(args.chatEvents.truncated ? { truncated: true } : {}),
          },
        }
      : {}),
    ...(args.capture ? { capture: args.capture } : {}),
  };
  await writeFile(join(recordingDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  args.log('[recording] wrote recording/manifest.json');
}
