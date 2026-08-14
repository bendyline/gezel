import type {
  ChatEventEnvelope,
  ChatMessage,
  ChatMessageToolCall,
  ChatSession,
} from '@bendyline/gezel';

export type CliOpenReferenceKind = 'artifact' | 'document' | 'workspace';

/** A file recently surfaced by the active project's chat stream. */
export interface CliOpenReference {
  key: string;
  kind: CliOpenReferenceKind;
  path: string;
  projectId: string;
}

export type CliOpenTarget =
  | { type: 'folder'; folder: 'artifacts' | 'workspace' }
  | { type: 'reference'; reference: CliOpenReference };

const MAX_RECENT_REFERENCES = 12;

/**
 * Promote newly observed references to the front of a bounded MRU. Paths are
 * normalized only for identity; the original spelling remains visible and is
 * sent back to the daemon when `/open` runs.
 */
export function rememberCliOpenReferences(
  current: ReadonlyArray<CliOpenReference>,
  observed: ReadonlyArray<CliOpenReference>,
  max = MAX_RECENT_REFERENCES,
): CliOpenReference[] {
  const next = [...current];
  for (const reference of observed) {
    const index = next.findIndex((candidate) => candidate.key === reference.key);
    if (index !== -1) next.splice(index, 1);
    next.unshift(reference);
  }
  return next.slice(0, max);
}

/** Collect file references carried by one live project-chat event. */
export function cliOpenReferencesFromEvent(env: ChatEventEnvelope): CliOpenReference[] {
  if (env.event.type === 'tool') {
    return referencesFromTool(env.event, env.projectId);
  }
  if (env.event.type === 'complete' || env.event.type === 'user_message') {
    return referencesFromMessage(env.event.message, env.projectId);
  }
  return [];
}

/** Seed the MRU when the user switches to a persisted thread. */
export function cliOpenReferencesFromSession(
  session: Pick<ChatSession, 'projectId' | 'messages'>,
): CliOpenReference[] {
  let recent: CliOpenReference[] = [];
  for (const message of session.messages) {
    recent = rememberCliOpenReferences(recent, referencesFromMessage(message, session.projectId));
  }
  return recent;
}

/** Resolve an entered `/open` argument exactly; partial matches are wordwheel-only. */
export function resolveCliOpenTarget(
  input: string,
  recentReferences: ReadonlyArray<CliOpenReference>,
): CliOpenTarget | null {
  const query = normalizeLookup(input);
  if (query === 'workspace' || query === 'artifacts') {
    return { type: 'folder', folder: query };
  }
  if (!query) return null;

  const exact = recentReferences.find((reference) => normalizeLookup(reference.path) === query);
  if (exact) return { type: 'reference', reference: exact };

  const basenameMatches = recentReferences.filter(
    (reference) => normalizeLookup(basename(reference.path)) === query,
  );
  return basenameMatches.length === 1
    ? { type: 'reference', reference: basenameMatches[0]! }
    : null;
}

function referencesFromMessage(message: ChatMessage, projectId: string): CliOpenReference[] {
  const references: CliOpenReference[] = [];
  for (const tool of message.toolCalls ?? []) {
    references.push(...referencesFromTool(tool, projectId));
  }
  // Tool rows precede the assistant body in the transcript. Body references
  // are therefore observed last and belong at the front of the MRU.
  for (const path of message.referencedArtifacts ?? []) {
    references.push(reference('artifact', path, projectId));
  }
  return references;
}

function referencesFromTool(
  tool: ChatMessageToolCall | Extract<ChatEventEnvelope['event'], { type: 'tool' }>,
  projectId: string,
): CliOpenReference[] {
  if (!tool.success) return [];
  const references: CliOpenReference[] = [];
  for (const media of [...(tool.images ?? []), ...(tool.audios ?? []), ...(tool.videos ?? [])]) {
    references.push(reference('artifact', media.path, projectId));
  }

  const kind = classifyTool(tool.name);
  if (!kind) return references;
  const paths = tool.paths && tool.paths.length > 0 ? tool.paths : tool.path ? [tool.path] : [];
  for (const path of paths) references.push(reference(kind, path, projectId));
  return references;
}

function classifyTool(name: string): CliOpenReferenceKind | null {
  const normalized = name.replaceAll('-', '_').toLowerCase();
  if (['read_artifact', 'write_artifact'].includes(normalized)) return 'artifact';
  if (['read_document', 'write_document'].includes(normalized)) return 'document';
  if (
    [
      'readfile',
      'read_file',
      'read_files',
      'writefile',
      'write_file',
      'replace_in_file',
      'replace_lines',
      'insert_at_marker',
      'apply_patch',
    ].includes(normalized)
  ) {
    return 'workspace';
  }
  return null;
}

function reference(kind: CliOpenReferenceKind, path: string, projectId: string): CliOpenReference {
  return {
    key: `${projectId}:${kind}:${normalizeLookup(path)}`,
    kind,
    path,
    projectId,
  };
}

export function normalizeCliOpenLookup(value: string): string {
  return normalizeLookup(value);
}

export function cliOpenBasename(path: string): string {
  return basename(path);
}

function normalizeLookup(value: string): string {
  return value.trim().replaceAll('\\', '/').toLowerCase();
}

function basename(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}
