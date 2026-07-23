import { describe, expect, it, vi } from 'vitest';

// Provide a minimal vscode shim so the LanguageModelTextPart class
// reference inside lm-provider.ts resolves at test time. We mirror just
// enough of the API surface that vscodeMessagesToOpenAI exercises.
vi.mock('vscode', () => {
  class LanguageModelTextPart {
    constructor(public readonly value: string) {}
  }
  class LanguageModelDataPart {
    constructor(
      public readonly data: Uint8Array,
      public readonly mimeType: string,
    ) {}
  }
  class LanguageModelToolCallPart {
    constructor(
      public readonly callId: string,
      public readonly name: string,
      public readonly input: object,
    ) {}
  }
  class LanguageModelToolResultPart {
    constructor(
      public readonly callId: string,
      public readonly content: unknown[],
    ) {}
  }
  return {
    LanguageModelTextPart,
    LanguageModelDataPart,
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    LanguageModelChatMessageRole: {
      User: 1,
      Assistant: 2,
      System: 3,
    },
    EventEmitter: class {
      event = () => () => {};
      fire = () => {};
      dispose = () => {};
    },
    Disposable: class {
      constructor(private readonly fn: () => void) {}
      dispose = () => this.fn();
    },
  };
});

import * as vscodeShim from 'vscode';
import { buildDetail, isLikelyConnectionError, vscodeMessagesToOpenAI } from './lm-provider.js';

const {
  LanguageModelTextPart,
  LanguageModelDataPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  LanguageModelChatMessageRole,
} = vscodeShim as unknown as {
  LanguageModelTextPart: new (s: string) => { value: string };
  LanguageModelDataPart: new (
    data: Uint8Array,
    mime: string,
  ) => {
    data: Uint8Array;
    mimeType: string;
  };
  LanguageModelToolCallPart: new (callId: string, name: string, input: object) => unknown;
  LanguageModelToolResultPart: new (callId: string, content: unknown[]) => unknown;
  LanguageModelChatMessageRole: { User: number; Assistant: number; System: number };
};

interface FakeMessage {
  role: number;
  content: Array<{ value: string }>;
  name: string | undefined;
}

function userText(text: string): FakeMessage {
  return {
    role: LanguageModelChatMessageRole.User,
    content: [new LanguageModelTextPart(text)],
    name: undefined,
  };
}

function assistantText(text: string): FakeMessage {
  return {
    role: LanguageModelChatMessageRole.Assistant,
    content: [new LanguageModelTextPart(text)],
    name: undefined,
  };
}

describe('vscodeMessagesToOpenAI', () => {
  it('translates user messages with role mapping', () => {
    const out = vscodeMessagesToOpenAI([userText('hello')] as never);
    expect(out).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('translates assistant messages', () => {
    const out = vscodeMessagesToOpenAI([assistantText('reply')] as never);
    expect(out).toEqual([{ role: 'assistant', content: 'reply' }]);
  });

  it('concatenates multi-part text content for a single message', () => {
    const msg = {
      role: LanguageModelChatMessageRole.User,
      content: [new LanguageModelTextPart('hello '), new LanguageModelTextPart('world')],
      name: undefined,
    };
    const out = vscodeMessagesToOpenAI([msg] as never);
    expect(out).toEqual([{ role: 'user', content: 'hello world' }]);
  });

  it('drops messages with only empty / whitespace content', () => {
    const msg = {
      role: LanguageModelChatMessageRole.User,
      content: [new LanguageModelTextPart('   ')],
      name: undefined,
    };
    const out = vscodeMessagesToOpenAI([msg] as never);
    expect(out).toEqual([]);
  });

  it('preserves multi-turn conversation order', () => {
    const out = vscodeMessagesToOpenAI([
      userText('turn1'),
      assistantText('reply1'),
      userText('turn2'),
    ] as never);
    expect(out).toEqual([
      { role: 'user', content: 'turn1' },
      { role: 'assistant', content: 'reply1' },
      { role: 'user', content: 'turn2' },
    ]);
  });

  it('ignores non-text parts silently', () => {
    const msg = {
      role: LanguageModelChatMessageRole.User,
      content: [
        new LanguageModelTextPart('text only'),
        { mime: 'application/octet-stream', data: new Uint8Array() } as unknown as never,
      ],
      name: undefined,
    };
    const out = vscodeMessagesToOpenAI([msg] as never);
    expect(out).toEqual([{ role: 'user', content: 'text only' }]);
  });

  it('translates an image data part into an image_url multimodal content array', () => {
    const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const msg = {
      role: LanguageModelChatMessageRole.User,
      content: [
        new LanguageModelTextPart('describe this'),
        new LanguageModelDataPart(data, 'image/png'),
      ],
      name: undefined,
    };
    const out = vscodeMessagesToOpenAI([msg] as never);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe('user');
    const content = out[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Array<{ type: string }>;
    expect(parts[0]?.type).toBe('text');
    const imagePart = parts[1] as { type: string; image_url: { url: string } };
    expect(imagePart.type).toBe('image_url');
    expect(imagePart.image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  it('translates an assistant tool-call part into a role:assistant message with tool_calls', () => {
    const msg = {
      role: LanguageModelChatMessageRole.Assistant,
      content: [new LanguageModelToolCallPart('call_xyz', 'lookup', { city: 'Amsterdam' })],
      name: undefined,
    };
    const out = vscodeMessagesToOpenAI([msg] as never);
    expect(out).toHaveLength(1);
    const assistant = out[0] as {
      role: string;
      content: string;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
    expect(assistant.role).toBe('assistant');
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls?.[0]?.id).toBe('call_xyz');
    expect(assistant.tool_calls?.[0]?.function.name).toBe('lookup');
    expect(JSON.parse(assistant.tool_calls?.[0]?.function.arguments ?? '{}')).toEqual({
      city: 'Amsterdam',
    });
  });

  it("translates a user tool-result part into a role:'tool' message with tool_call_id", () => {
    const msg = {
      role: LanguageModelChatMessageRole.User,
      content: [
        new LanguageModelToolResultPart('call_xyz', [
          new LanguageModelTextPart('15 degrees, sunny'),
        ]),
      ],
      name: undefined,
    };
    const out = vscodeMessagesToOpenAI([msg] as never);
    expect(out).toHaveLength(1);
    const toolMsg = out[0] as { role: string; content: string; tool_call_id: string };
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.content).toBe('15 degrees, sunny');
    expect(toolMsg.tool_call_id).toBe('call_xyz');
  });

  it('emits both a tool-result message and a follow-up user text message for a combined message', () => {
    const msg = {
      role: LanguageModelChatMessageRole.User,
      content: [
        new LanguageModelToolResultPart('call_1', [new LanguageModelTextPart('result body')]),
        new LanguageModelTextPart('follow-up'),
      ],
      name: undefined,
    };
    const out = vscodeMessagesToOpenAI([msg] as never);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      role: 'tool',
      content: 'result body',
      tool_call_id: 'call_1',
    });
    expect(out[1]).toEqual({ role: 'user', content: 'follow-up' });
  });
});

describe('isLikelyConnectionError', () => {
  it('matches undici TypeError: fetch failed (the canonical "daemon dropped the connection" shape)', () => {
    const err = new TypeError('fetch failed');
    expect(isLikelyConnectionError(err)).toBe(true);
  });

  it('matches TypeError with a wrapped ECONNREFUSED cause (undici nests SystemError)', () => {
    const inner = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:51234'), {
      code: 'ECONNREFUSED',
    });
    const outer = Object.assign(new TypeError('fetch failed'), { cause: inner });
    expect(isLikelyConnectionError(outer)).toBe(true);
  });

  it('matches a bare error with a Node SystemError code (ECONNRESET, EPIPE, ETIMEDOUT, …)', () => {
    for (const code of [
      'ECONNREFUSED',
      'ECONNRESET',
      'EPIPE',
      'ENOTFOUND',
      'ETIMEDOUT',
      'UND_ERR_SOCKET',
      'UND_ERR_CLOSED',
    ]) {
      const err = Object.assign(new Error(`socket failure with code ${code}`), { code });
      expect(isLikelyConnectionError(err)).toBe(true);
    }
  });

  it('does NOT match an AbortError (caller cancelled — reconnect would be wrong)', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(isLikelyConnectionError(err)).toBe(false);
  });

  it('does NOT match a generic Error without a code or matching message', () => {
    expect(isLikelyConnectionError(new Error('Gezel chat failed: 500 Internal Server Error'))).toBe(
      false,
    );
  });

  it('does NOT match a non-Error throwable (string, plain object)', () => {
    expect(isLikelyConnectionError('boom')).toBe(false);
    expect(isLikelyConnectionError({ message: 'fetch failed' })).toBe(false);
    expect(isLikelyConnectionError(undefined)).toBe(false);
    expect(isLikelyConnectionError(null)).toBe(false);
  });

  it('walks the cause chain without infinite-looping when an error references itself', () => {
    const err: Error & { cause?: unknown } = new Error('outer');
    err.cause = err;
    expect(isLikelyConnectionError(err)).toBe(false);
  });
});

describe('buildDetail (picker label)', () => {
  it('joins role and model with a separator', () => {
    expect(buildDetail({ role: 'Planner' }, 'gpt-4o-mini')).toBe('Planner · gpt-4o-mini');
  });

  it('falls back to role only when model is unresolved', () => {
    expect(buildDetail({ role: 'Planner' }, undefined)).toBe('Planner');
  });

  it('falls back to model only when role is absent', () => {
    expect(buildDetail({}, 'claude-3-5-sonnet')).toBe('claude-3-5-sonnet');
  });

  it('returns undefined when neither role nor model is available', () => {
    expect(buildDetail({}, undefined)).toBeUndefined();
  });
});
