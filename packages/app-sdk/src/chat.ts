import type { GezelClient } from '@bendyline/gezel-client/node';
import { streamChatEvents } from '@bendyline/gezel-client/node';
import { GezelSdkError } from './errors.js';
import type { ChatTurnEvent, OpenChatOptions } from './host-types.js';

export interface GezelChatDeps {
  client: GezelClient;
}

/**
 * One conversation with one gezel, in one project.
 *
 * A turn is an async iterable rather than a callback list because that is what
 * a chat UI actually consumes — and because an iterable that ends carries the
 * end of the turn, which a callback has to signal separately.
 */
export class GezelChat {
  constructor(
    private readonly client: GezelClient,
    readonly sessionId: string,
    readonly gezelId: string,
    readonly projectId: string,
  ) {}

  /**
   * Send a message and stream the reply.
   *
   * The event stream is opened *before* the message is posted. The daemon
   * accepts a send and answers asynchronously, so a subscriber that attaches
   * afterwards can miss the opening tokens of a fast local model.
   */
  async *send(message: string, opts: { signal?: AbortSignal } = {}): AsyncGenerator<ChatTurnEvent> {
    const stream = streamChatEvents({
      url: this.client.sessionEventsUrl(this.sessionId),
      headers: this.client.authHeader(),
      fetch: this.client.getFetch(),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    // Pull nothing yet; `streamChatEvents` connects on the first `next()`, so
    // prime it with one tick before the send lands.
    const first = stream.next();
    await this.client.sendToChatSession(this.sessionId, message);

    let pending = await first;
    while (!pending.done) {
      const event = toTurnEvent(pending.value);
      if (event.type === 'error') {
        throw new GezelSdkError(event.message, { code: 'turn_failed' });
      }
      yield event;
      if (event.type === 'done') return;
      pending = await stream.next();
    }
  }

  /** Send and collect the final text, for callers that do not stream. */
  async sendAndCollect(
    message: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ text: string; toolCalls: Array<{ name: string; success: boolean }> }> {
    let text = '';
    const toolCalls: Array<{ name: string; success: boolean }> = [];
    for await (const event of this.send(message, opts)) {
      if (event.type === 'complete') text = event.content;
      else if (event.type === 'delta' && !text) text += event.content;
      else if (event.type === 'tool') toolCalls.push({ name: event.name, success: event.success });
    }
    return { text, toolCalls };
  }

  /** Answer a question the gezel asked through `ask_user_question`. */
  answer(questionId: string, selectedChoices: number[], freeText?: string): Promise<unknown> {
    return this.client.answerQuestion(questionId, {
      selectedChoices,
      ...(freeText ? { freeText } : {}),
    });
  }
}

/**
 * Open (or resume) a conversation.
 *
 * Resuming by default is the friendlier behaviour for an app that opens a chat
 * panel on every launch: the user sees the thread they left, not an empty one.
 */
export async function openChat(deps: GezelChatDeps, opts: OpenChatOptions): Promise<GezelChat> {
  const gezelId = await resolveGezelId(deps.client, opts);
  if (opts.reuseLatestSession !== false) {
    const { sessions } = await deps.client.listChatSessions({
      gezelId,
      projectId: opts.projectId,
    });
    const latest = sessions
      .filter((session) => !session.archived && !session.taskRef)
      .sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1))[0];
    if (latest) return new GezelChat(deps.client, latest.id, gezelId, opts.projectId);
  }
  const created = await deps.client.createChatSession({ gezelId, projectId: opts.projectId });
  return new GezelChat(deps.client, created.id, gezelId, opts.projectId);
}

/**
 * Resolve which gezel to talk to. An app usually keeps the ids `ensureProject`
 * returned, but addressing by role keeps app code readable and survives a
 * gezel being recreated.
 */
async function resolveGezelId(client: GezelClient, opts: OpenChatOptions): Promise<string> {
  if (opts.gezelId) return opts.gezelId;
  if (!opts.role) {
    throw new GezelSdkError('openChat needs either gezelId or role', {
      code: 'gezel_not_specified',
    });
  }
  const project = await client.getProject(opts.projectId);
  const roster = new Set(project.gezelIds ?? []);
  const { gezels } = await client.listGezels();
  const wanted = opts.role.trim().toLowerCase();
  const match =
    gezels.find(
      (gezel) =>
        roster.has(gezel.id) &&
        (gezel.templateId === opts.role || gezel.role?.trim().toLowerCase() === wanted),
    ) ??
    gezels.find(
      (gezel) => gezel.templateId === opts.role || gezel.role?.trim().toLowerCase() === wanted,
    );
  if (!match) {
    throw new GezelSdkError(`no gezel with role "${opts.role}" in project ${opts.projectId}`, {
      code: 'gezel_not_found',
    });
  }
  return match.id;
}

/**
 * Narrow the daemon's event vocabulary to what an app acts on. Anything else
 * passes through as `other` so a new daemon event never breaks a consumer.
 */
function toTurnEvent(event: { type: string } & Record<string, unknown>): ChatTurnEvent {
  switch (event.type) {
    case 'delta':
      return { type: 'delta', content: String(event.content ?? '') };
    case 'reasoning_delta':
      return { type: 'reasoning_delta', content: String(event.content ?? '') };
    case 'tool':
      return {
        type: 'tool',
        name: String(event.name ?? ''),
        success: event.success !== false,
        ...(event.errorMessage ? { errorMessage: String(event.errorMessage) } : {}),
      };
    case 'tool_args_delta':
      return {
        type: 'tool_args_delta',
        name: String(event.name ?? ''),
        content: String(event.content ?? ''),
      };
    case 'complete':
      return {
        type: 'complete',
        content: String((event.message as { content?: string } | undefined)?.content ?? ''),
      };
    case 'question_asked':
      return { type: 'question_asked', question: event.question };
    case 'question_answered':
      return { type: 'question_answered', question: event.question };
    case 'warning':
      return { type: 'warning', message: String(event.message ?? event.warning ?? '') };
    case 'error':
      return { type: 'error', message: String(event.error ?? event.message ?? 'the turn failed') };
    case 'done':
      return { type: 'done' };
    default:
      return { type: 'other', event };
  }
}
