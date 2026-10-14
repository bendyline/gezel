import {
  type AppSubject,
  type ChatSession,
  type PromptAppSubject,
  type RetrievalSource,
  createLogger,
  isItemFocus,
  parseAppSubjectState,
  renderAppSubjectStateLine,
} from '@bendyline/gezel';
import type { AppToolBinding, AppToolRelayRegistry } from '../app-tools/relay-registry.js';

const log = createLogger('chat');

/**
 * How long a turn waits for the app to say what the person has selected.
 * Office answers in tens of milliseconds; a pane that is busy or gone must
 * not hold the person's turn, so past this the turn goes without the line.
 */
export const APP_SUBJECT_STATE_TIMEOUT_MS = 3_000;

/** The binding whose chat declared an item, among those offered to a session. */
export function subjectBinding(
  bindings: readonly AppToolBinding[],
): (AppToolBinding & { subject: AppSubject }) | undefined {
  return bindings.find((binding): binding is AppToolBinding & { subject: AppSubject } =>
    Boolean(binding.subject),
  );
}

/**
 * The item a session's prompt describes: the live registration of the
 * surface driving it, else the thread's own stamp with the app out of reach
 * (the pane closed, someone wrote from the desktop app, or the gezel runs on
 * a provider that cannot call app tools). Undefined for every other session.
 */
export function promptAppSubjectFor(
  record: Pick<ChatSession, 'subject'>,
  bindings: readonly AppToolBinding[],
): PromptAppSubject | undefined {
  const live = subjectBinding(bindings);
  if (live) {
    const subject = live.subject;
    return {
      focus: subject.focus ?? 'item',
      kind: subject.kind,
      app: subject.app,
      title: subject.title,
      saved: Boolean(subject.path),
      editable: subject.editable ?? true,
      connected: true,
      toolNames: live.tools.map((tool) => tool.name),
      readsSelection: Boolean(subject.stateTool),
    };
  }
  const stamp = record.subject;
  if (!stamp) return undefined;
  return {
    focus: 'item',
    kind: stamp.kind,
    app: stamp.app,
    title: stamp.title,
    saved: stamp.key.startsWith('file:'),
    editable: false,
    connected: false,
    toolNames: [],
    readsSelection: false,
  };
}

/**
 * Corpora a thread about one document keeps out of proactive retrieval.
 * Project files injected beside "add a paragraph about X" read as the place
 * the paragraph should go — the incident that opened this work injected a
 * beer-brewing glossary and a stray `<!DOCTYPE html>` into a Word chat. The
 * shared library, memories and knowledge catalogs stay: house style and the
 * Handboek are what a writer wants beside a document. The `search` tool
 * still reaches the project's files when the person asks for them.
 */
export function retrievalExclusionsFor(
  subject: PromptAppSubject | undefined,
): readonly RetrievalSource[] {
  return isItemFocus(subject) ? ['workspace', 'artifacts'] : [];
}

/**
 * Ask the app what the person has selected, and render the line that opens
 * their turn. Null when the item declares no state tool, the app is not
 * connected, or it does not answer in time: the turn goes on without it.
 */
export async function readAppSubjectStateLine(args: {
  registry: AppToolRelayRegistry;
  binding: AppToolBinding & { subject: AppSubject };
  session: Pick<ChatSession, 'id' | 'gezelId' | 'projectId'>;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string | null> {
  const tool = args.binding.subject.stateTool;
  if (!tool) return null;
  try {
    const result = await args.registry.invoke(args.binding, {
      tool,
      args: {},
      sessionId: args.session.id,
      gezelId: args.session.gezelId,
      projectId: args.session.projectId,
      timeoutMs: args.timeoutMs ?? APP_SUBJECT_STATE_TIMEOUT_MS,
      ...(args.signal ? { signal: args.signal } : {}),
    });
    if (!result.ok) {
      log.debug(`app subject state unavailable for ${args.session.id}: ${result.error}`);
      return null;
    }
    const content =
      typeof result.content === 'string'
        ? result.content
        : result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
    const state = parseAppSubjectState(content);
    return state ? renderAppSubjectStateLine(args.binding.subject, state) : null;
  } catch (err) {
    log.debug(
      `app subject state read failed for ${args.session.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
