import {
  isExpectedBinaryDocumentDeliverablePath,
  isExpectedImageDeliverablePath,
} from '../deliverable-paths.js';
import { displayName } from '../gezel-display.js';
import type { MessageGezelRequest } from '../schemas/api.js';
import type { FileTurnIntent } from '../schemas/file-turn-intent.js';
import type { ChatMessage } from '../schemas/gezel.js';
import type { ChatSession, ExpectedDeliverable } from '../schemas/session.js';
import { validatePortablePath } from './files.js';
import { portableToolSurface } from './product-tools.js';
import type { PortableStore } from './store.js';

/** A turn hint describes the requested operation; it never expands tool authority. */
export function portableFileTurnContext(
  intent: FileTurnIntent | undefined,
  deliverable: ExpectedDeliverable | undefined,
): string {
  if (!intent && !deliverable) return '';
  return [
    '### Requested file work',
    'The following structured request is a per-turn execution hint. Follow the supplied request and preserve unrelated work. It grants no additional filesystem or tool access. A file deliverable must be saved through an available file tool; a chat response alone does not create it.',
    JSON.stringify({ fileTurnIntent: intent, expectedDeliverable: deliverable }),
  ].join('\n');
}

export function validatePortableMessageHints(
  intent?: FileTurnIntent,
  deliverable?: ExpectedDeliverable,
): void {
  if (intent) {
    validatePortablePath(intent.path);
    if (intent.kind === 'repair-file') {
      if (intent.mutationPath) validatePortablePath(intent.mutationPath);
      for (const path of intent.readPaths ?? []) validatePortablePath(path);
    }
  }
  if (deliverable?.filePath) validatePortablePath(deliverable.filePath);
  if (
    deliverable?.kind === 'file' &&
    deliverable.filePath &&
    (isExpectedBinaryDocumentDeliverablePath(deliverable.filePath) ||
      isExpectedImageDeliverablePath(deliverable.filePath))
  )
    throw new Error(
      'This file requires a document, media, or image production capability unavailable on this host.',
    );
  if (deliverable?.checks?.length || deliverable?.scripts?.length)
    throw new Error('Use a task completion gate for checked deliverables on this host.');
}

/** Resolve the ordinary client message destination without creating a second chat model. */
export async function preparePortableMessage(
  store: PortableStore,
  toIdOrName: string,
  body: MessageGezelRequest,
  hasScripts: boolean,
  check: () => void = () => {},
): Promise<{ session: ChatSession; from: NonNullable<ChatMessage['from']>; toName: string }> {
  validatePortableMessageHints(body.fileTurnIntent, body.expectedDeliverable);
  const sender = await store.getGezel(body.fromGezelId);
  if (!sender) throw new Error('Sending gezel not found');
  const origin = body.fromSessionId ? await store.getSession(sender.id, body.fromSessionId) : null;
  if (body.fromSessionId && !origin)
    throw new Error('Sending conversation does not belong to this gezel');
  const roster = await store.listGezels();
  const direct = roster.find((g) => g.id === toIdOrName);
  const names = roster.filter((g) =>
    [g.name, g.roleBasedName].some((name) => name?.toLowerCase() === toIdOrName.toLowerCase()),
  );
  const target = direct ?? (names.length === 1 ? names[0] : undefined);
  if (!target) throw new Error('Choose an unambiguous gezel id or display name from the crew.');
  if (target.id === sender.id) throw new Error('A gezel cannot message itself');
  let projectId = body.projectId ?? origin?.projectId ?? 'default';
  const sessions = await store.listSessions({ gezelId: target.id });
  if (!body.projectId && projectId === 'default') {
    const projects = new Set(
      sessions.filter((s) => !s.archived && s.projectId !== 'default').map((s) => s.projectId),
    );
    if (projects.size === 1) projectId = [...projects][0]!;
  }
  if (!(await store.getProject(projectId))) throw new Error('Project not found');
  const config = await store.readConfig();
  const latest = sessions
    .filter((s) => s.projectId === projectId && !s.archived && !s.taskRef)
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
  const session = latest ? await store.getSession(target.id, latest.id) : null;
  // Validate a file request against the current role and project before allocating a session.
  const probe = session ?? { gezelId: target.id, projectId };
  if (
    body.expectedDeliverable?.kind === 'file' &&
    !(await portableToolSurface(store, probe, hasScripts)).some((t) => t.name === 'write_file')
  )
    throw new Error('This gezel cannot write workspace files in the selected project.');
  check();
  const current = session ?? (await store.createSession({ gezelId: target.id, projectId }));
  return {
    session: current,
    from: {
      gezelId: sender.id,
      gezelName: displayName(
        sender,
        current.roleBasedNameOnlyMode ?? config.roleBasedNameOnlyMode ?? false,
      ),
      ...(origin ? { sessionId: origin.id } : {}),
      kind: 'delegation',
    },
    toName: displayName(
      target,
      origin?.roleBasedNameOnlyMode ?? config.roleBasedNameOnlyMode ?? false,
    ),
  };
}
