import { describe, expect, it } from 'vitest';
import { translateMessages } from './translate.js';

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('translateMessages — multimodal', () => {
  it('extracts a single image from the last user message', () => {
    const result = translateMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${TINY_PNG}` },
          },
        ],
      },
    ]);
    expect(result.prompt).toBe('What is this?');
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.mimeType).toBe('image/png');
    expect(result.attachments[0]?.base64).toBe(TINY_PNG);
    expect(result.attachments[0]?.filename).toMatch(/\.png$/);
  });

  it('supports image-only requests (no text part) with the prompt left empty', () => {
    const result = translateMessages([
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${TINY_PNG}` },
          },
        ],
      },
    ]);
    expect(result.prompt).toBe('');
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.mimeType).toBe('image/jpeg');
  });

  it('keeps backwards compatibility with the string content form', () => {
    const result = translateMessages([{ role: 'user', content: 'just text' }]);
    expect(result.prompt).toBe('just text');
    expect(result.attachments).toEqual([]);
  });

  it('throws a helpful error when an image_url is not a data: URI', () => {
    expect(() =>
      translateMessages([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'see this' },
            { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
          ],
        },
      ]),
    ).toThrow(/data: URI/);
  });

  it('only surfaces images from the LAST message — prior turn images are dropped', () => {
    const result = translateMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'prior turn' },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${TINY_PNG}` },
          },
        ],
      },
      { role: 'assistant', content: 'I see it' },
      { role: 'user', content: 'follow-up text only' },
    ]);
    expect(result.attachments).toEqual([]);
    expect(result.priorMessages).toHaveLength(2);
  });

  it('rejects when the last message has neither text nor images', () => {
    expect(() =>
      translateMessages([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        // Empty text-only content array would fail Zod earlier; here we
        // simulate the case by passing only whitespace text + no images.
        { role: 'user', content: [{ type: 'text', text: '  ' }] },
      ]),
    ).toThrow();
  });
});
