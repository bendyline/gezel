import { describe, expect, it } from 'vitest';
import { TOOL_IMAGES_MESSAGE, retireInspectedToolImages } from './tool-image-retention.js';

describe('retireInspectedToolImages', () => {
  const images = { role: 'user', content: TOOL_IMAGES_MESSAGE, images: ['a', 'b'] };

  it('keeps tool images on the request right after the tool returned them', () => {
    const messages = [{ role: 'user', content: 'Evaluate the deck.' }, images];
    expect(retireInspectedToolImages(messages)).toBe(messages);
  });

  it('drops them once the model has answered after seeing them', () => {
    const messages = [images, { role: 'assistant', content: 'Slides look right.' }];
    const out = retireInspectedToolImages(messages);
    expect(out[0]).not.toHaveProperty('images');
    expect(out[0]?.content).toContain('2 image(s)');
    expect(messages[0]).toHaveProperty('images');
  });

  it('never retires a picture the user attached', () => {
    const attached = { role: 'user', content: 'What is on this slide?', images: ['x'] };
    const messages = [attached, { role: 'assistant', content: 'A pizza.' }];
    expect(retireInspectedToolImages(messages)).toBe(messages);
  });
});
