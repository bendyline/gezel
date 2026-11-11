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
  message_gezel: 'briefs someone on the crew',
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
  save_artifact: 'saves the file',
  write_task_note: 'leaves a note on the task',
  advance_task_step: 'moves to the next step',
  convert_document: 'builds the document',
  preview_document: 'previews the pages',
  inspect_document: 'checks the document',
  copy_artifact_to_workspace: 'delivers the file',
  ensure_gezel: 'brings someone onto the crew',
  make_dir: 'makes a folder',
  list_roots: 'looks around',
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
  let body = cut === -1 ? text : text.slice(0, cut);
  // Storage plumbing (content hashes, root ids) ends what a viewer reads.
  const plumbing = body.search(/\s*\(?\b(sha256|root[- ][0-9a-f]{6,})|\b[0-9a-f]{24,}\b/i);
  if (plumbing > 0) body = `${body.slice(0, plumbing).replace(/[\s,;:(]+$/, '')}…`;
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

/**
 * Plumbing in a reasoning trace: the gezel restating its instructions,
 * naming tools, task ids and drawers. True words, but not what a viewer
 * came to see.
 */
const THOUGHT_PLUMBING =
  /\w_\w|\[|\bprocedure\b|\binstruction|\bthe user wants me\b|\bfirst action\b|\bharness\b|\bprompt\b|\btool\b|\bdrawer\b|\bartifacts?\b|\beval\b|\bpersona\b|\bsystem note\b|\bassigned as\b|\bI am the\b|\bcheckpoint\b|\btask note|\bin parallel\b|\bper my\b|\w+\/\d|\{/i;

/** First person: the gezel talking about what it will do, not reciting a checklist. */
const THOUGHT_FIRST_PERSON = /\b(I|I'll|I'm|I've|I'd|my|let's|let me|we)\b/i;

/** Words that mark a gezel deciding something, which is the part worth showing. */
const THOUGHT_DECISION =
  /\b(I'll|I will|let's|so I|next|should I|decide|pick|choose|plan|structure|order|looks|matches|legible|instead|rather|but|hmm|wait|actually)\b/gi;

interface ThoughtUnit {
  text: string;
  /** Starts a new line when joined (a new line in the trace). */
  newLine: boolean;
  plumbing: boolean;
}

/**
 * The part of a reasoning trace a viewer can follow: the best run of
 * plain-language sentences in which the gezel speaks for itself, cut at a
 * sentence or line boundary to fit `maxChars`. The words are the model's
 * own; only the selection is ours (markdown emphasis and code ticks
 * dropped). Returns '' when nothing in the trace reads without the
 * plumbing around it.
 */
export function thoughtExcerpt(text: string, maxChars = 320): string {
  const units: ThoughtUnit[] = [];
  // A trace cut by the distiller ends in "…": that last thought is partial.
  const cut = /…\s*$/.test(text);
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const rawLine of lines) {
    const line = rawLine
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^[*-]\s+/, '• ')
      .replace(/^(\d+[.)])\s+/, '$1 ');
    const isListItem = /^(•|\d+[.)])\s/.test(line);
    const pieces = isListItem
      ? [line]
      : (line.match(/[\s\S]*?[.!?]+["”’)]*(?=\s|$)|[\s\S]+$/g) ?? [line]);
    let firstPiece = true;
    for (const piece of pieces) {
      const unitText = piece.trim();
      if (unitText.length === 0) continue;
      units.push({
        text: unitText,
        newLine: units.length > 0 && firstPiece,
        plumbing: THOUGHT_PLUMBING.test(unitText),
      });
      firstPiece = false;
    }
  }
  const last = units[units.length - 1];
  if (last && (cut || !/[.!?:"”’)]$/.test(last.text))) last.plumbing = true;

  let best: { start: number; end: number; score: number } | undefined;
  for (let start = 0; start < units.length; start++) {
    if (units[start]!.plumbing) continue;
    let length = 0;
    let score = 0;
    let firstPerson = false;
    for (let end = start; end < units.length; end++) {
      const unit = units[end]!;
      if (unit.plumbing) break;
      length += unit.text.length + 1;
      if (length > maxChars) break;
      const own = THOUGHT_FIRST_PERSON.test(unit.text);
      firstPerson ||= own;
      score +=
        unit.text.length * (own ? 1 : 0.5) + 40 * (unit.text.match(THOUGHT_DECISION)?.length ?? 0);
      if (firstPerson && (!best || score > best.score)) best = { start, end, score };
    }
  }
  if (!best) return '';
  let out = '';
  for (let i = best.start; i <= best.end; i++) {
    const unit = units[i]!;
    out += i === best.start ? unit.text : `${unit.newLine ? '\n' : ' '}${unit.text}`;
  }
  return out.length >= 60 ? out : '';
}
