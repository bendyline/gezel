import { describe, expect, it } from 'vitest';
import {
  ChatSessionSchema,
  ChatSessionSummarySchema,
  CreateChatSessionRequestSchema,
  ListChatSessionsResponseSchema,
  SendToSessionRequestSchema,
} from './session.js';

const validSession = {
  version: 1 as const,
  id: 'sess-1',
  gezelId: 'ada',
  projectId: 'default',
  providerName: 'copilot' as const,
  model: 'claude-sonnet-4.5',
  title: 'Hello',
  createdAt: '2026-04-14T10:00:00Z',
  lastActivityAt: '2026-04-14T10:05:00Z',
  messages: [
    { role: 'user' as const, content: 'hi', at: '2026-04-14T10:00:00Z' },
    { role: 'assistant' as const, content: 'hi back', at: '2026-04-14T10:00:05Z' },
  ],
  providerState: { copilotSessionId: 'cs-1' },
};

describe('ChatSessionSchema', () => {
  it('parses a minimal valid session', () => {
    const out = ChatSessionSchema.parse(validSession);
    expect(out.id).toBe('sess-1');
    expect(out.messages).toHaveLength(2);
    expect(out.providerState.copilotSessionId).toBe('cs-1');
  });

  it('accepts openaiPreviousResponseId instead of copilotSessionId', () => {
    const out = ChatSessionSchema.parse({
      ...validSession,
      providerName: 'openai',
      providerState: { openaiPreviousResponseId: 'resp_abc' },
    });
    expect(out.providerState.openaiPreviousResponseId).toBe('resp_abc');
  });

  it('rejects unknown providerName', () => {
    expect(() => ChatSessionSchema.parse({ ...validSession, providerName: 'bedrock' })).toThrow();
  });

  it('requires version: 1', () => {
    expect(() => ChatSessionSchema.parse({ ...validSession, version: 2 })).toThrow();
  });

  it('requires projectId (never gezel-only)', () => {
    const copy = { ...validSession } as Record<string, unknown>;
    delete copy.projectId;
    expect(() => ChatSessionSchema.parse(copy)).toThrow();
  });

  it('accepts optional archived + resumeFailed + aboutSnapshot', () => {
    const out = ChatSessionSchema.parse({
      ...validSession,
      archived: true,
      resumeFailed: true,
      aboutSnapshot: 'about text',
    });
    expect(out.archived).toBe(true);
    expect(out.resumeFailed).toBe(true);
    expect(out.aboutSnapshot).toBe('about text');
  });

  it('accepts the capability-routing model source marker', () => {
    const out = ChatSessionSchema.parse({
      ...validSession,
      modelSource: 'capability-routing',
    });
    expect(out.modelSource).toBe('capability-routing');
  });

  it('preserves read-only external conversation provenance', () => {
    const source = {
      kind: 'external' as const,
      appId: 'pi',
      appName: 'Pi',
      externalConversationId: 'pi-session-1',
      readOnly: true as const,
      workingDirectory: '/work/racing-game',
    };
    const session = ChatSessionSchema.parse({ ...validSession, source });
    const summary = ChatSessionSummarySchema.parse({ ...validSession, source });

    expect(session.source).toEqual(source);
    expect(summary.source).toEqual(source);
  });
});

describe('ChatSessionSummarySchema', () => {
  it('strips messages + providerState', () => {
    const out = ChatSessionSummarySchema.parse({
      id: 'x',
      gezelId: 'g',
      projectId: 'default',
      providerName: 'copilot',
      title: 'T',
      createdAt: '2026-04-14T10:00:00Z',
      lastActivityAt: '2026-04-14T10:00:00Z',
      lastMessagePreview: 'The latest reply',
      involvedGezelIds: ['g', 'reviewer'],
    });
    expect(out.id).toBe('x');
    expect(out.lastMessagePreview).toBe('The latest reply');
    expect(out.involvedGezelIds).toEqual(['g', 'reviewer']);
    expect((out as Record<string, unknown>).messages).toBeUndefined();
    expect((out as Record<string, unknown>).providerState).toBeUndefined();
  });
});

describe('CreateChatSessionRequestSchema', () => {
  it('requires gezelId', () => {
    expect(() => CreateChatSessionRequestSchema.parse({})).toThrow();
  });
  it('accepts projectId optionally', () => {
    const out = CreateChatSessionRequestSchema.parse({ gezelId: 'ada' });
    expect(out.gezelId).toBe('ada');
    expect(out.projectId).toBeUndefined();
  });
});

describe('SendToSessionRequestSchema', () => {
  it('rejects empty message', () => {
    expect(() => SendToSessionRequestSchema.parse({ message: '' })).toThrow();
  });
  it('accepts a non-empty message', () => {
    expect(SendToSessionRequestSchema.parse({ message: 'hi' }).message).toBe('hi');
  });
});

describe('ListChatSessionsResponseSchema', () => {
  it('round-trips an empty list', () => {
    expect(ListChatSessionsResponseSchema.parse({ sessions: [] }).sessions).toEqual([]);
  });
});
