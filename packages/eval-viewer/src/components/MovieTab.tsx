import { useEffect, useMemo, useState } from 'react';
import type { Trial } from '../types.js';

/**
 * Transcript view over a trial's `recording/transcript.json` (the
 * distilled RunRecording the eval runner writes for every trial).
 *
 * Deliberately dependency-free and duck-typed, like the rest of the
 * viewer: the shapes are read defensively so a recording written by a
 * newer runner still renders (unknown kinds fall back to a generic
 * row). The animated Movie mode (squisq DocPlayer) arrives as a second
 * sub-mode; this chronological list is the debugging bedrock and works
 * for every recording, always.
 */

interface RecordingActor {
  id: string;
  name?: string;
  role?: string;
  kind?: string;
  meester?: boolean;
}

interface RecordingScene {
  kind: string;
  at: string;
  actorId?: string;
  sessionId?: string;
  taskRef?: string;
  excerpt?: string;
  // tool-call
  name?: string;
  argsSummary?: string;
  success?: boolean;
  durationMs?: number;
  count?: number;
  path?: string;
  diffStats?: { addedLines?: number; removedLines?: number };
  // delegation
  toActorId?: string;
  delegationKind?: string;
  // step / gate
  stepId?: string;
  stepName?: string;
  phase?: string;
  verdict?: string;
  attempt?: number;
  // artifact
  store?: string;
  bytes?: number;
  screenshotRef?: string;
  reason?: string;
  state?: string;
}

interface Recording {
  trial?: { startedAt?: string; success?: boolean; reason?: string; durationMs?: number };
  actors?: RecordingActor[];
  scenes?: RecordingScene[];
  budget?: { droppedScenes?: number; truncatedExcerpts?: number };
}

const KIND_LABEL: Record<string, string> = {
  'user-prompt': 'prompt',
  reasoning: 'thinking',
  'tool-call': 'tool',
  reply: 'reply',
  delegation: 'handoff',
  'step-transition': 'step',
  'gate-verdict': 'gate',
  'artifact-produced': 'artifact',
  question: 'question',
  'turn-aborted': 'aborted',
  note: 'note',
};

export function MovieTab({ trial }: { trial: Trial }) {
  const [recording, setRecording] = useState<Recording | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRecording(null);
    setError(null);
    fetch(`${trial.runUrl}/recording/transcript.json`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return (await res.json()) as Recording;
      })
      .then((data) => {
        if (!cancelled) setRecording(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [trial.runUrl]);

  const actorsById = useMemo(() => {
    const map = new Map<string, RecordingActor>();
    for (const actor of recording?.actors ?? []) map.set(actor.id, actor);
    return map;
  }, [recording]);

  if (error) {
    return (
      <div className="empty">
        No recording could be loaded ({error}). Older run dirs can be backfilled with{' '}
        <code>pnpm --filter @bendyline/gezel-evals exec tsx src/bin/distill-recording.ts</code>.
      </div>
    );
  }
  if (!recording) return <div className="empty">Loading recording…</div>;
  const scenes = recording.scenes ?? [];
  if (scenes.length === 0) return <div className="empty">The recording holds no scenes.</div>;

  const startMs = Date.parse(recording.trial?.startedAt ?? scenes[0]?.at ?? '') || 0;
  const nameOf = (id: string | undefined): string =>
    (id ? actorsById.get(id)?.name : undefined) ?? (id === 'user' ? 'You' : (id ?? '—'));

  return (
    <div className="movietab">
      <p className="logmeta">
        {scenes.length} scene(s)
        {recording.budget?.droppedScenes
          ? ` · ${recording.budget.droppedScenes} dropped for size`
          : ''}
        {' · '}
        <a href={`${trial.runUrl}/recording/transcript.json`} target="_blank" rel="noreferrer">
          transcript.json
        </a>
        {' · '}
        <a href={`${trial.runUrl}/recording/`} target="_blank" rel="noreferrer">
          recording files
        </a>
      </p>
      <ol className="movie-scenes">
        {scenes.map((scene, index) => (
          <li
            key={`${scene.at}|${scene.kind}|${index}`}
            className={`movie-scene movie-scene--${scene.kind}`}
          >
            <span className="movie-clock">{formatOffset(Date.parse(scene.at) - startMs)}</span>
            <span className={`movie-kind movie-kind--${scene.kind}`}>
              {KIND_LABEL[scene.kind] ?? scene.kind}
            </span>
            <span className="movie-actor">{sceneActorLabel(scene, nameOf)}</span>
            <span className="movie-body">{sceneBody(scene, trial)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function sceneActorLabel(
  scene: RecordingScene,
  nameOf: (id: string | undefined) => string,
): string {
  if (scene.kind === 'delegation') {
    const arrow = scene.delegationKind === 'consultation' ? '⇢' : '→';
    return `${nameOf(scene.actorId)} ${arrow} ${nameOf(scene.toActorId)}`;
  }
  return nameOf(scene.actorId);
}

function sceneBody(scene: RecordingScene, trial: Trial) {
  switch (scene.kind) {
    case 'tool-call': {
      const bits = [
        `${scene.name ?? '?'}${scene.count && scene.count > 1 ? ` ×${scene.count}` : ''}`,
        scene.success === false ? 'FAILED' : null,
        scene.path ?? null,
        scene.argsSummary ?? null,
        scene.diffStats
          ? `+${scene.diffStats.addedLines ?? 0} −${scene.diffStats.removedLines ?? 0}`
          : null,
        scene.durationMs !== undefined ? `${Math.round(scene.durationMs)}ms` : null,
      ].filter((bit): bit is string => bit !== null);
      return <code>{bits.join('  ·  ')}</code>;
    }
    case 'step-transition':
      return (
        <span>
          <strong>{scene.stepName ?? scene.stepId}</strong> {scene.phase}
          {scene.taskRef ? ` (${scene.taskRef})` : ''}
        </span>
      );
    case 'gate-verdict':
      return (
        <span>
          <strong>{scene.verdict === 'pass' ? 'PASS' : 'REJECTED'}</strong>
          {scene.attempt ? ` attempt ${scene.attempt}` : ''}
          {scene.excerpt ? ` — ${scene.excerpt}` : ''}
        </span>
      );
    case 'artifact-produced':
      return (
        <span>
          <code>{scene.path}</code>
          {scene.bytes ? ` (${formatBytes(scene.bytes)})` : ''}
          {scene.screenshotRef ? (
            <a
              className="movie-shot"
              href={`${trial.runUrl}/recording/${scene.screenshotRef}`}
              target="_blank"
              rel="noreferrer"
            >
              <img
                src={`${trial.runUrl}/recording/${scene.screenshotRef}`}
                alt={scene.path ?? 'screenshot'}
                loading="lazy"
              />
            </a>
          ) : null}
        </span>
      );
    case 'turn-aborted':
      return <span>{scene.reason ?? 'turn cut short'}</span>;
    default:
      return <span>{scene.excerpt ?? ''}</span>;
  }
}

function formatOffset(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m === 0) return `t+${s}s`;
  return `t+${m}m${String(s % 60).padStart(2, '0')}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
