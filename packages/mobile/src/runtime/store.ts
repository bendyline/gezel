import { initialPoppetjeForGezel } from '@bendyline/gezel/poppetje';
import {
  MOBILE_MAX_STATE_CHARS,
  type MobileSession,
  type MobileState,
  MobileStateSchema,
} from '@bendyline/gezel/schemas';
import type { MobileRuntimeOptions } from './contracts.js';

export const MOBILE_MEESTER_ABOUT =
  'You are Mira, the Meester: a thoughtful, warm companion who helps people think through their work and decide what help they need. ' +
  'Use clear, everyday language. This mobile preview supports conversation only. ' +
  'You can discuss and plan, but cannot create crew members, run tools, access files, or perform actions outside this conversation. ' +
  'Be honest about those limits and never claim to have completed such actions.';

export function newSession(options: Pick<MobileRuntimeOptions, 'now' | 'createId'>): MobileSession {
  const at = options.now();
  return {
    id: options.createId(),
    gezelId: 'meester',
    projectId: 'default',
    title: 'New conversation',
    createdAt: at,
    lastActivityAt: at,
    messages: [],
  };
}

export function initialState(options: MobileRuntimeOptions): MobileState {
  const session = newSession(options);
  return MobileStateSchema.parse({
    version: 1,
    gezel: {
      id: 'meester',
      name: 'Mira',
      role: 'Meester',
      about: MOBILE_MEESTER_ABOUT,
      poppetje: initialPoppetjeForGezel('meester', 'Mira'),
    },
    project: {
      id: 'default',
      name: 'My space',
      createdAt: session.createdAt,
      updatedAt: session.createdAt,
    },
    sessions: [session],
    activeSessionId: session.id,
  });
}

export function parseState(data: string): MobileState {
  if (data.length > MOBILE_MAX_STATE_CHARS)
    throw new Error(
      'Saved mobile conversations exceed the supported size. They have not been replaced.',
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error(
      'Saved mobile conversations contain invalid JSON. They have not been replaced.',
    );
  }
  const result = MobileStateSchema.safeParse(parsed);
  if (!result.success)
    throw new Error(
      'Saved mobile conversations use an unsupported or invalid format. They have not been replaced.',
    );
  return result.data;
}

export function serializeState(state: MobileState): string {
  const data = `${JSON.stringify(MobileStateSchema.parse(state), null, 2)}\n`;
  if (data.length > MOBILE_MAX_STATE_CHARS)
    throw new Error(
      'Mobile conversation storage is full. Your saved conversations have not been replaced.',
    );
  return data;
}

export function copyState(state: MobileState): MobileState {
  return MobileStateSchema.parse(state);
}

export { searchConversations } from './search.js';

export function recoverInterrupted(state: MobileState): boolean {
  let changed = false;
  for (const session of state.sessions) {
    for (const message of session.messages) {
      if (message.status !== 'streaming') continue;
      message.status = 'interrupted';
      message.stopReason = 'cancelled';
      message.error = 'This response was interrupted when the app closed.';
      changed = true;
    }
  }
  return changed;
}
