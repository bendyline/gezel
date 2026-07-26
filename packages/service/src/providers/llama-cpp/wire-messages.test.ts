import { describe, expect, it } from 'vitest';
import { type ChatMessage, toWireMessages } from './provider.js';

const img = { base64: 'AAAA', mimeType: 'image/png', filename: 'shot.png' };

describe('toWireMessages', () => {
  it('leaves plain messages untouched', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ];
    expect(toWireMessages(messages)).toEqual(messages);
  });

  /**
   * The regression this file exists for. Per-turn nudges append to
   * `userMsg.content` in place AFTER the request body is assembled, relying on
   * the body holding the same objects as the session's message list. An
   * earlier version of this transform copied every message, which silently
   * dropped every nudge — 18 provider tests caught it, but only because they
   * assert on the serialized body.
   */
  it('returns unattached messages by reference so later in-place edits still land', () => {
    const userMsg: ChatMessage = { role: 'user', content: 'do the thing' };
    const wire = toWireMessages([userMsg]);
    expect(wire[0]).toBe(userMsg);

    userMsg.content += '\n\n[Local-model edit mode: …]';
    expect(JSON.stringify(wire)).toContain('[Local-model edit mode:');
  });

  it('expands attachments into OpenAI typed content parts', () => {
    const wire = toWireMessages([{ role: 'user', content: 'what is this?', attachments: [img] }]);
    expect(wire[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    });
  });

  // The Ollama-shaped `images: string[]` field this replaced was silently
  // ignored by llama-server, so no local model could ever see an attachment.
  it('never emits an images array or a raw attachments key', () => {
    const json = JSON.stringify(
      toWireMessages([{ role: 'user', content: 'q', attachments: [img] }]),
    );
    expect(json).not.toContain('"images"');
    expect(json).not.toContain('"attachments"');
  });

  it('carries every attachment on the turn', () => {
    const wire = toWireMessages([
      {
        role: 'user',
        content: 'compare these',
        attachments: [img, { ...img, base64: 'BBBB', mimeType: 'image/jpeg' }],
      },
    ]);
    const parts = wire[0]!.content as Array<{ type: string }>;
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(2);
  });

  it('drops an empty attachments array rather than serializing it', () => {
    const wire = toWireMessages([{ role: 'user', content: 'q', attachments: [] }]);
    expect(wire[0]).toEqual({ role: 'user', content: 'q' });
    expect(JSON.stringify(wire)).not.toContain('attachments');
  });

  it('preserves tool-call plumbing on messages it rewrites', () => {
    const wire = toWireMessages([
      {
        role: 'user',
        content: 'q',
        attachments: [img],
        tool_call_id: 'call_1',
        reasoning_content: 'thought',
      },
    ]);
    expect(wire[0]).toMatchObject({ tool_call_id: 'call_1', reasoning_content: 'thought' });
  });
});
