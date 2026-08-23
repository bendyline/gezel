import type { ChatEvent, GezelConfig } from '@bendyline/gezel';
import { createLogger, getEngagementMode, isEngagementAllowed } from '@bendyline/gezel';
import type { ChatEventBus } from '../chat/events.js';
import type { ChatManager } from '../chat/manager.js';
import type { Store } from '../fs/store.js';
import type { VisitorRecord } from './visitors.js';

const log = createLogger('app-serve');

/** Lifetime message cap per visitor — a stranger gets a conversation, not a pipe. */
export const VISITOR_CHAT_MESSAGE_CAP = 50;

export interface VisitorChatDeps {
  store: Store;
  chat: ChatManager;
  chatEvents: ChatEventBus;
}

/**
 * The whitelist projection of the 38-member ChatEvent union a visitor may
 * see: text in, text out, errors, done. Tool frames, reasoning, phases,
 * telemetry, and every other internal never crosses the serve boundary.
 */
export type VisitorChatEvent =
  | { type: 'delta'; content: string }
  | { type: 'user_message'; content: string; at?: string }
  | { type: 'complete'; content: string; at?: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

export function projectVisitorEvent(event: ChatEvent): VisitorChatEvent | null {
  switch (event.type) {
    case 'delta':
      return { type: 'delta', content: event.content };
    case 'user_message':
      return {
        type: 'user_message',
        content: event.message.content,
        ...(event.message.at ? { at: event.message.at } : {}),
      };
    case 'complete':
      return {
        type: 'complete',
        content: event.message.content,
        ...(event.message.at ? { at: event.message.at } : {}),
      };
    case 'error':
      // The full error can leak provider/config detail; visitors get a flat line.
      return { type: 'error', message: 'the reply failed — try again' };
    case 'cancelled':
    case 'done':
      return { type: 'done' };
    default:
      return null;
  }
}

/**
 * Resolve the gezel a site's visitors talk to: the project lead
 * (`voormanGezelId`), else the first roster gezel. Null = chat unavailable.
 */
export async function resolveVisitorChatGezel(
  store: Store,
  projectId: string,
): Promise<string | null> {
  const project = await store.getProject(projectId).catch(() => null);
  if (!project) return null;
  return project.voormanGezelId ?? project.gezelIds?.[0] ?? null;
}

/**
 * One isolated session per visitor, created lazily on first send —
 * deliberately NOT `ensureOrCreateSession`, which would splice strangers
 * into the owner's active thread. The `visitorAccess` flag strips the tool
 * surface and excludes the session from memory extraction at build time.
 */
export async function ensureVisitorChatSession(
  deps: VisitorChatDeps,
  args: { projectId: string; visitor: VisitorRecord },
): Promise<{ sessionId: string } | { error: string; status: 403 | 503 }> {
  if (args.visitor.chatSessionId) return { sessionId: args.visitor.chatSessionId };
  const gezelId = await resolveVisitorChatGezel(deps.store, args.projectId);
  if (!gezelId) {
    return { error: 'this site has no gezel available for chat', status: 503 };
  }
  const record = await deps.chat.createSession({
    gezelId,
    projectId: args.projectId,
    visitorAccess: true,
  });
  args.visitor.chatSessionId = record.id;
  log.info(`[chat] visitor session ${record.id} created for project ${args.projectId}`);
  return { sessionId: record.id };
}

export function engagementBlocked(config: GezelConfig): string | null {
  return isEngagementAllowed(config)
    ? null
    : `engagement mode is ${getEngagementMode(config)}; chat is disabled`;
}
