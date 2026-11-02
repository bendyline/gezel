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

/**
 * What a tool call does, in words a first-time viewer follows. Unknown
 * tools fall back to their de-snaked name, so a new tool still reads.
 */
const TOOL_VERBS: Readonly<Record<string, string>> = {
  suggest_work: 'finds the right plan',
  search: 'searches the sources',
  read_artifact: 'reads a note',
  list_artifacts: 'checks the notes',
  start_work: 'starts the project',
  message_gezel: 'briefs a teammate',
  write_file: 'writes a file',
  write_artifact: 'saves the result',
  replace_in_file: 'edits a file',
  append_to_file: 'adds to a file',
  read_file: 'reads a file',
  list_files: 'looks through the files',
  search_files: 'searches the files',
  generate_image: 'draws an image',
  web_search: 'searches the web',
  fetch_url: 'reads a web page',
  wikipedia_search: 'searches Wikipedia',
  wikipedia_read: 'reads a Wikipedia article',
  knowledge_search: 'searches the library',
  run_nodejs_script: 'runs a script',
  create_task: 'creates a task',
  complete_step: 'finishes a step',
  docblocks_create_document: 'creates a document',
  docblocks_export: 'exports the document',
};

export function toolVerb(name: string): string {
  return TOOL_VERBS[name] ?? `uses ${humanToolName(name)}`;
}

/**
 * On-screen text for the marketing cut: markdown emphasis removed, and the
 * structured hand-off instructions Gezel appends to a delegation
 * (`[Deliverable expected as …]`) cut, so a viewer reads the request, not
 * the plumbing. The debug cut keeps every character.
 */
export function cleanExcerpt(text: string): string {
  const cut = text.search(/\n?\s*\[(Deliverable|Your first assistant action)/i);
  const body = cut === -1 ? text : text.slice(0, cut);
  return body
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+\n/g, '\n')
    .trim();
}

/**
 * One short caption per scene for the marketing cut. The bubble already
 * shows the words, so the caption names the beat instead of repeating them.
 */
export function marketingCaption(
  scene: RunRecordingScene,
  actors: Map<string, RunRecordingActor>,
): string {
  const name = (id: string | undefined): string =>
    (id ? actors.get(id)?.name : undefined) ?? (id === 'user' ? 'You' : (id ?? 'Someone'));
  const actor = name(scene.actorId);
  switch (scene.kind) {
    case 'user-prompt':
      return 'The job, in your words.';
    case 'reasoning':
      return `${actor} thinks it through.`;
    case 'tool-call':
      return `${actor} ${toolVerb(scene.name)}.`;
    case 'reply':
      return `${actor} reports back.`;
    case 'delegation':
      return scene.delegationKind === 'consultation'
        ? `${actor} asks ${name(scene.toActorId)}.`
        : `${actor} hands off to ${name(scene.toActorId)}.`;
    case 'step-transition':
      return narrationLine(scene, actors);
    case 'gate-verdict':
      return scene.verdict === 'pass'
        ? 'The quality check passes.'
        : 'The quality check sends it back.';
    case 'artifact-produced':
      return scene.screenshotRef ? 'The finished work.' : `${actor} saves ${scene.path}.`;
    case 'question':
      return `${actor} asks a question.`;
    case 'turn-aborted':
      return `${actor}'s turn was cut short.`;
    case 'note':
      return `${actor} leaves a note.`;
  }
}

export function coverTitle(recording: RunRecording, override?: string): string {
  if (override) return override;
  return (
    recording.provenance?.title ??
    recording.trial?.scenarioId ??
    recording.provenance?.craftbookId ??
    'A gezel run'
  );
}

export function coverSubtitle(recording: RunRecording, modelLabel?: string): string {
  const model = modelLabel ?? recording.provenance?.modelId ?? recording.trial?.modelId;
  // Bill the cast by prominence — scene count — not roster order, or the
  // cover credits whoever sorts first alphabetically while the actual
  // protagonists go unnamed.
  const sceneCounts = new Map<string, number>();
  for (const scene of recording.scenes) {
    if (scene.actorId) sceneCounts.set(scene.actorId, (sceneCounts.get(scene.actorId) ?? 0) + 1);
    if (scene.kind === 'delegation') {
      sceneCounts.set(scene.toActorId, (sceneCounts.get(scene.toActorId) ?? 0) + 1);
    }
  }
  const cast = recording.actors
    .filter((actor) => actor.kind === 'gezel' && (sceneCounts.get(actor.id) ?? 0) > 0)
    .sort((a, b) => (sceneCounts.get(b.id) ?? 0) - (sceneCounts.get(a.id) ?? 0))
    .map((actor) => actor.name);
  const castLine = cast.length > 0 ? `with ${cast.slice(0, 4).join(', ')}` : '';
  return [castLine, model ? `on ${model}` : ''].filter((part) => part.length > 0).join(' · ');
}
