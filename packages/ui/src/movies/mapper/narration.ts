import type { RunRecording, RunRecordingActor, RunRecordingScene } from '@bendyline/gezel';

/**
 * One plain-English line per scene — the caption track's text and the
 * reading-time basis for marketing pacing. Kept deliberately short and
 * concrete: captions render word-by-word in `social` style.
 */
export function narrationLine(
  scene: RunRecordingScene,
  actors: Map<string, RunRecordingActor>,
): string {
  const name = (id: string | undefined): string =>
    (id ? actors.get(id)?.name : undefined) ?? (id === 'user' ? 'You' : (id ?? 'Someone'));
  const actor = name(scene.actorId);
  switch (scene.kind) {
    case 'user-prompt':
      return scene.excerpt ? `The ask: ${scene.excerpt}` : 'The work begins.';
    case 'reasoning':
      return `${actor} thinks it through.`;
    case 'tool-call': {
      const times = scene.count && scene.count > 1 ? ` ×${scene.count}` : '';
      const target = scene.path ? ` on ${scene.path}` : '';
      return `${actor} uses ${humanToolName(scene.name)}${times}${target}.`;
    }
    case 'reply':
      return scene.excerpt ? `${actor}: ${scene.excerpt}` : `${actor} reports back.`;
    case 'delegation': {
      const to = name(scene.toActorId);
      const verb = scene.delegationKind === 'consultation' ? 'asks' : 'hands off to';
      return scene.excerpt ? `${actor} ${verb} ${to}: ${scene.excerpt}` : `${actor} ${verb} ${to}.`;
    }
    case 'step-transition': {
      const step = scene.stepName ?? scene.stepId;
      if (scene.phase === 'activated') return `Step: ${step}.`;
      if (scene.phase === 'completed') return `Step done: ${step}.`;
      return `Step ${scene.phase}: ${step}.`;
    }
    case 'gate-verdict':
      return scene.verdict === 'pass'
        ? 'The quality gate passes.'
        : `The quality gate pushes back${scene.attempt ? ` (attempt ${scene.attempt})` : ''}.`;
    case 'artifact-produced':
      return `${actor} produces ${scene.path}.`;
    case 'question':
      return scene.state === 'answered' ? 'Question answered.' : `${actor} asks a question.`;
    case 'turn-aborted':
      return `${actor}'s turn was cut short.`;
    case 'note':
      return scene.excerpt ? `${actor} notes: ${scene.excerpt}` : `${actor} leaves a note.`;
  }
}

export function humanToolName(name: string): string {
  return name.replace(/[_-]+/g, ' ');
}

export function coverTitle(recording: RunRecording): string {
  return (
    recording.provenance?.title ??
    recording.trial?.scenarioId ??
    recording.provenance?.craftbookId ??
    'A gezel run'
  );
}

export function coverSubtitle(recording: RunRecording): string {
  const model = recording.provenance?.modelId ?? recording.trial?.modelId;
  const cast = recording.actors
    .filter((actor) => actor.kind === 'gezel')
    .map((actor) => actor.name);
  const castLine = cast.length > 0 ? `with ${cast.slice(0, 4).join(', ')}` : '';
  return [castLine, model ? `on ${model}` : ''].filter((part) => part.length > 0).join(' · ');
}
