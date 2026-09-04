export interface RecordingActor {
  id: string;
  name?: string;
  role?: string;
  kind?: string;
  meester?: boolean;
}

export interface RecordingScene {
  kind: string;
  at: string;
  actorId?: string;
  sessionId?: string;
  taskRef?: string;
  excerpt?: string;
  name?: string;
  argsSummary?: string;
  success?: boolean;
  durationMs?: number;
  count?: number;
  path?: string;
  diffStats?: { addedLines?: number; removedLines?: number };
  toActorId?: string;
  delegationKind?: string;
  stepId?: string;
  stepName?: string;
  phase?: string;
  verdict?: string;
  attempt?: number;
  store?: string;
  bytes?: number;
  screenshotRef?: string;
  reason?: string;
  state?: string;
}

export interface Recording {
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

export function sceneKindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

export function sceneActorLabel(
  scene: RecordingScene,
  nameOf: (id: string | undefined) => string,
): string {
  if (scene.kind === 'delegation') {
    const arrow = scene.delegationKind === 'consultation' ? '⇢' : '→';
    return `${nameOf(scene.actorId)} ${arrow} ${nameOf(scene.toActorId)}`;
  }
  return nameOf(scene.actorId);
}

export function formatToolCallScene(scene: RecordingScene): string {
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
  return bits.join('  ·  ');
}

export function formatMovieOffset(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `t+${seconds}s`;
  return `t+${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
}

export function formatMovieBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
