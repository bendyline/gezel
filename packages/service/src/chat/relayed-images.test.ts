import type { ChatMessage } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  collectMadePictures,
  picturesOnlyReplyText,
  relayedPicturesNote,
} from './relayed-images.js';

type ToolCall = NonNullable<ChatMessage['toolCalls']>[number];

const call = (over: Partial<ToolCall> & Pick<ToolCall, 'name'>): ToolCall => ({
  durationMs: 1,
  success: true,
  ...over,
});

// The tail of a real `generate_image` result (2026-11-11 Illustrator turn).
const GENERATED = (path: string) =>
  `Generated 448×768 image with sd-turbo (seed 1616578158, 4 steps, 25660ms). The user already sees this image inline below the tool call. To read its bytes, call \`read_artifact\` with path \`${path}\`.`;

describe('collectMadePictures', () => {
  it('takes the path generate_image reported over its thumbnail copy', () => {
    const pictures = collectMadePictures({
      toolCalls: [
        call({
          name: 'generate_image',
          resultText: GENERATED('generated/image-2026-11-12T03-58-16-230Z-1616578158.png'),
          images: [{ path: 'sessions/2026-11-12_035730/tool-0-img-0.png', mimeType: 'image/png' }],
        }),
      ],
    });
    expect(pictures).toEqual([
      { path: 'generated/image-2026-11-12T03-58-16-230Z-1616578158.png', mimeType: 'image/png' },
    ]);
  });

  it('falls back to the thumbnail when the reported path is not in the result', () => {
    const thumb = { path: 'sessions/s/tool-0-img-0.png', mimeType: 'image/png' };
    expect(
      collectMadePictures({
        toolCalls: [call({ name: 'generate_image', resultText: 'Generated…', images: [thumb] })],
      }),
    ).toEqual([thumb]);
  });

  it('reads render_image paths', () => {
    expect(
      collectMadePictures({
        toolCalls: [
          call({
            name: 'render_image',
            resultText:
              'Rendered 64×64 image/jpeg to artifacts/renders/heart.jpg (1.2 KB, engine=skia).\n\nTo embed this…',
          }),
        ],
      }),
    ).toEqual([{ path: 'renders/heart.jpg', mimeType: 'image/jpeg' }]);
  });

  it('leaves out screenshots, reads and failed renders, and repeats', () => {
    const shot = { path: 'sessions/s/tool-0-img-0.png', mimeType: 'image/png' };
    expect(
      collectMadePictures({
        toolCalls: [
          call({ name: 'browser_snapshot', images: [shot] }),
          call({ name: 'read_image_as_base64', images: [shot] }),
          call({
            name: 'generate_image',
            success: false,
            resultText: GENERATED('generated/a.png'),
          }),
          call({ name: 'generate_image', resultText: GENERATED('generated/b.png') }),
          call({ name: 'generate_image', resultText: GENERATED('generated/b.png') }),
        ],
      }),
    ).toEqual([{ path: 'generated/b.png', mimeType: 'image/png' }]);
  });

  it('is empty for a turn with no tool calls', () => {
    expect(collectMadePictures({})).toEqual([]);
  });
});

describe('relayedPicturesNote', () => {
  it('names each path and forbids a link of its own', () => {
    const note = relayedPicturesNote('Bayu', [
      { path: 'generated/a.png', mimeType: 'image/png' },
      { path: 'generated/b.png', mimeType: 'image/png' },
    ]);
    expect(note).toBe(
      "(System note for this turn: Bayu made 2 pictures, and the person sees them with Bayu's message below: `artifacts/generated/a.png`, `artifacts/generated/b.png`. To point to them, name their exact paths. Never write an image link or a web address for them.)",
    );
  });
});

describe('picturesOnlyReplyText', () => {
  it('counts the pictures', () => {
    expect(picturesOnlyReplyText(1)).toBe('Sent a picture.');
    expect(picturesOnlyReplyText(3)).toBe('Sent 3 pictures.');
  });
});
