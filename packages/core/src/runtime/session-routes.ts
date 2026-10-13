import {
  LIVE_CRAFTBOOK_LAUNCH_STATUSES,
  chatLaunchInvocationKeyAsync,
} from '../craftbook-invocation-key.js';
import { composeCraftbookLaunch, stringifyCraftbookParamValues } from '../craftbook-launch.js';
import { isEngagementAllowed } from '../engagement.js';
import type { PortableInference } from '../mobile/inference.js';
import { rewritePromptDraftFileRefs } from '../prompt-drafts.js';
import type { Craftbook } from '../schemas/craftbook.js';
import type { ChatEvent, ChatMessage } from '../schemas/gezel.js';
import { MobileProviderIdSchema } from '../schemas/mobile-provider.js';
import type { PromptDraftMeta } from '../schemas/prompt-draft.js';
import {
  type ChatSession,
  CreateChatSessionRequestSchema,
  LaunchTaskFromSessionRequestSchema,
} from '../schemas/session.js';
import type { Task } from '../schemas/task.js';
import { NEW_THREAD_TITLE, deriveThreadTitleFromMessages } from '../thread-title.js';
import { craftbookStartCardForTask } from '../tool-cards.js';
import { draftMatchesSession } from './draft-address.js';
import { HttpStatusError as ProductError } from './http/errors.js';
import { json } from './http/json.js';
import type { PortableStore } from './store.js';
import { PortableTaskInputError } from './task-inputs.js';
import type { PortableTaskRunner } from './task-routes.js';

type SessionScope = Pick<ChatSession, 'id' | 'gezelId' | 'projectId'>;

/**
 * What the conversation routes reach in the product service. They run under
 * its admission lock like every other route; stopping a conversation does
 * not, so the service answers that one itself.
 */
export interface PortableSessionRouteHost {
  store: PortableStore;
  inference: PortableInference;
  tasks: Pick<PortableTaskRunner, 'create' | 'run'>;
  /** Turns waiting for the engine or running on it, by conversation. */
  turns: ReadonlyMap<string, { session: ChatSession; startedAt: number }>;
  /** Sends accepted and still being set up, by conversation. */
  admissions: ReadonlyMap<string, { sessionId: string; startedAt: number }>;
  /** A conversation as the service holds it, including one whose save is pending. */
  session(id: string): Promise<ChatSession>;
  submit(id: string, body: Record<string, unknown>): Promise<unknown>;
  interrupt(id: string, body: Record<string, unknown>): Promise<unknown>;
  assertNoConflict(): void;
  sessionBusy(sessionId: string): boolean;
  /** Refuse to delete or archive conversations that still have work in flight. */
  assertSessionsFree(match: (scope: SessionScope) => boolean): void;
  resolveCraftbook(
    id: string,
    source?: string,
    version?: string,
    projectId?: string,
  ): Promise<Craftbook | undefined>;
  draftChanged(draft: PromptDraftMeta): void;
  emit(session: SessionScope, event: ChatEvent): void;
}

/** The message a turn is answering; a finished turn has appended its reply after it. */
function lastUserText(session: ChatSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const message = session.messages[i]!;
    if (message.role === 'user') return message.content;
  }
  return '';
}

/**
 * The composer's attached task (`POST /api/sessions/:id/launch-task`): the
 * craftbook task starts from this message with no model turn, and the
 * thread gets the message and a launch receipt, exactly as on the desktop.
 */
async function launchTaskFromSession(
  host: PortableSessionRouteHost,
  session: ChatSession,
  body: unknown,
): Promise<Response> {
  const request = LaunchTaskFromSessionRequestSchema.parse(body);
  const { launch } = request;
  host.assertNoConflict();
  // A running turn holds its own copy of the session and rewrites it.
  if (host.sessionBusy(session.id))
    throw new ProductError(
      'Wait for the current response in this conversation to finish, or stop it first.',
      409,
    );
  if (!isEngagementAllowed(await host.store.readConfig()))
    throw new ProductError('AI engagement is off. Turn it on in Settings to start work.', 403);
  if (launch.tonight) throw new ProductError('Running a task tonight needs the desktop app.', 501);
  const text = request.draftId
    ? rewritePromptDraftFileRefs(request.message, request.draftId)
    : request.message;
  const book = await host.resolveCraftbook(
    launch.craftbookId,
    launch.craftbookSourceId,
    undefined,
    session.projectId,
  );
  if (!book) {
    return json({ error: `craftbook "${launch.craftbookId}" is not on this device` }, 404);
  }
  const composed = composeCraftbookLaunch({
    message: text,
    craftbookName: book.name,
    paramSchema: book.paramSchema,
    params: stringifyCraftbookParamValues(launch.params),
  });
  const key = await chatLaunchInvocationKeyAsync({
    sessionId: session.id,
    ...(request.draftId ? { draftId: request.draftId } : {}),
    message: request.message,
    launch: launch as unknown as Record<string, unknown>,
  });
  // A retried POST finds the live task it made. With its receipt in the
  // thread nothing is written twice; without one (a write that failed after
  // the task existed) the receipt is written now instead of a second task.
  const prior = (await host.store.listTasks({ projectId: session.projectId })).find(
    (t) =>
      t.origin?.kind === 'craftbook-invocation' &&
      t.origin.key === key &&
      LIVE_CRAFTBOOK_LAUNCH_STATUSES.has(t.status),
  );
  if (prior) {
    let at = -1;
    for (let i = session.messages.length - 1; i >= 0 && at < 0; i--) {
      const m = session.messages[i]!;
      if (
        m.synthetic === 'craftbook-launch' &&
        m.toolCalls?.some((call) => call.card?.taskRef === prior.ref)
      )
        at = i;
    }
    const userMessage = at > 0 ? session.messages[at - 1] : undefined;
    if (at >= 0 && userMessage?.role === 'user') {
      return json({ task: prior, userMessage, receipt: session.messages[at], reused: true });
    }
  }
  if (request.draftId) {
    const draft = await host.store.getPromptDraft(session.projectId, request.draftId);
    if (!draft) throw new ProductError('Draft not found', 404);
    if (draft.status !== 'draft' || !draftMatchesSession(draft, session))
      throw new ProductError('This draft is not available to send in this conversation', 409);
  }
  let task: Task;
  if (prior) task = prior;
  else {
    try {
      task = await host.tasks.create(session.projectId, {
        title: launch.title?.trim() || book.name,
        description: composed.description,
        craftbookId: launch.craftbookId,
        ...(launch.craftbookSourceId ? { craftbookSourceId: launch.craftbookSourceId } : {}),
        ...(Object.keys(composed.params).length > 0 ? { craftbookParams: composed.params } : {}),
        ...(launch.inputs && Object.keys(launch.inputs).length > 0
          ? { inputs: launch.inputs }
          : {}),
        ...(launch.assignee ? { assignee: launch.assignee } : {}),
        createdBy: { kind: 'user' },
        launchSessionId: session.id,
        craftbookInvocationKey: key,
      });
    } catch (error) {
      if (error instanceof PortableTaskInputError) {
        return json({ error: error.message, code: 'task-input', param: error.param }, 422);
      }
      throw error;
    }
  }
  const at = new Date().toISOString();
  const userMessage: ChatMessage = {
    role: 'user',
    content: text,
    at,
    ...(request.draftId ? { draftId: request.draftId } : {}),
  };
  const card = craftbookStartCardForTask(task);
  const receipt: ChatMessage = {
    role: 'assistant',
    synthetic: 'craftbook-launch',
    content: `Started the "${task.craftbook.name}" craftbook — task ${task.ref}.`,
    at: new Date().toISOString(),
    toolCalls: [
      {
        name: 'invoke_craftbook',
        at,
        durationMs: 0,
        success: true,
        argsSummary: `${task.craftbook.name} · ${task.ref}`,
        ...(card ? { card } : {}),
      },
    ],
  };
  session.messages.push(userMessage, receipt);
  if (!session.title || session.title === NEW_THREAD_TITLE)
    session.title = deriveThreadTitleFromMessages([userMessage]) ?? book.name;
  try {
    await host.store.writeSession(session, request.draftId ? { sentDraftId: request.draftId } : {});
  } catch (error) {
    session.messages.splice(-2, 2);
    throw error;
  }
  if (request.draftId) {
    const draft = await host.store.getPromptDraft(session.projectId, request.draftId);
    if (draft) host.draftChanged(draft);
  }
  host.emit(session, { type: 'user_message', message: userMessage });
  host.emit(session, { type: 'complete', message: receipt });
  host.emit(session, { type: 'done' });
  void host.tasks.run(task.ref).catch(() => {});
  return json({ task, userMessage, receipt, reused: false }, 201);
}

/** The `/api/sessions` routes; `null` for any other request. */
export async function handlePortableSessionRoute(
  host: PortableSessionRouteHost,
  request: Request,
  url: URL,
  body: Record<string, unknown>,
  parts: string[],
): Promise<Response | null> {
  const [resource, id, action] = parts;
  if (resource !== 'sessions') return null;
  const method = request.method;
  const query = url.searchParams;
  if (!id) {
    if (method === 'GET')
      return json({
        sessions: await host.store.listSessions({
          gezelId: query.get('gezel') ?? undefined,
          projectId: query.get('project') ?? undefined,
        }),
      });
    if (method === 'POST') {
      const input = CreateChatSessionRequestSchema.parse(body);
      const gezel = await host.store.getGezel(input.gezelId);
      const config = await host.store.readConfig();
      const providerName = MobileProviderIdSchema.parse(
        gezel?.provider ?? config.provider ?? 'llama-cpp',
      );
      const inventory = providerName === 'llama-cpp' ? await host.inference.models?.() : undefined;
      const model = gezel?.parsed.frontmatter.model ?? inventory?.selectedModelId ?? providerName;
      if (inventory && !inventory.models.some((item) => item.id === model))
        throw new ProductError(
          gezel?.parsed.frontmatter.model
            ? `The model assigned to ${gezel.name} is not installed. Import it in Settings → Artificial Intelligence, or change this gezel's model.`
            : inventory.models.length === 0
              ? 'No chat model is installed on this device. Download or import one in Settings → Artificial Intelligence, then send your message again.'
              : 'Choose an available chat model in Settings → Artificial Intelligence, then send your message again.',
          409,
        );
      return json(await host.store.createSession({ ...input, providerName, model }));
    }
  }
  if (id === 'inflight') {
    // A send is in flight from the moment it is accepted, as on desktop:
    // while it is set up, while it waits for the engine, and while it runs.
    const entries = [
      ...[...host.turns.values()].map((t) => ({ session: t.session, startedAt: t.startedAt })),
      ...(
        await Promise.all(
          [...host.admissions.values()]
            .filter((a) => !host.turns.has(a.sessionId))
            .map(async (a) => {
              const session = await host.session(a.sessionId).catch(() => undefined);
              return session ? [{ session, startedAt: a.startedAt }] : [];
            }),
        )
      ).flat(),
    ];
    return json({
      inflight: entries
        .filter(
          ({ session }) =>
            (!query.get('project') || query.get('project') === session.projectId) &&
            (!query.get('gezel') || query.get('gezel') === session.gezelId),
        )
        .map(({ session, startedAt }) => ({
          sessionId: session.id,
          gezelId: session.gezelId,
          projectId: session.projectId,
          ...(session.taskRef ? { taskRef: session.taskRef } : {}),
          providerName: session.providerName,
          ...(session.model ? { model: session.model } : {}),
          userText: lastUserText(session),
          startedAt,
          elapsedMs: Date.now() - startedAt,
        })),
    });
  }
  if (id) {
    const session = await host.session(id);
    if (!action && method === 'GET') return json(session);
    if (action === 'inflight') {
      const turn = host.turns.get(id);
      const startedAt = turn?.startedAt ?? host.admissions.get(id)?.startedAt;
      return json({
        inflight:
          startedAt === undefined
            ? null
            : {
                userText: lastUserText(turn?.session ?? session),
                startedAt,
                elapsedMs: Date.now() - startedAt,
              },
      });
    }
    if (action === 'send' && method === 'POST') return json(await host.submit(id, body));
    if (action === 'launch-task' && method === 'POST')
      return launchTaskFromSession(host, session, body);
    if (action === 'interrupt' && method === 'POST') return json(await host.interrupt(id, body));
    if (action === 'archive' && method === 'POST') {
      host.assertSessionsFree((scope) => scope.id === id);
      session.archived = true;
      await host.store.writeSession(session);
      return json(session);
    }
    if (!action && method === 'DELETE') {
      host.assertSessionsFree((scope) => scope.id === id);
      await host.store.deleteSession(session.gezelId, id);
      return json({ ok: true });
    }
  }
  return null;
}
