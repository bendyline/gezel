import { describe, expect, it } from 'vitest';
import { mergeImageSizeSettings, parseImageSettingsFromText } from './image-cues.js';

const parse = (text: string) => {
  const { settings, prompt } = parseImageSettingsFromText(text);
  return { settings, prompt };
};

describe('parseImageSettingsFromText', () => {
  it('reads a named ratio and takes it out of the prompt', () => {
    expect(parse('a lighthouse at dusk, 9:16')).toEqual({
      settings: { aspectRatio: '9:16' },
      prompt: 'a lighthouse at dusk',
    });
    expect(parse('a lighthouse at dusk in 16x9 aspect ratio')).toEqual({
      settings: { aspectRatio: '16:9' },
      prompt: 'a lighthouse at dusk',
    });
  });

  it('reads the formats people name instead of ratios', () => {
    expect(parse('a fox in the snow as a phone wallpaper')).toEqual({
      settings: { aspectRatio: '9:16' },
      prompt: 'a fox in the snow',
    });
    expect(parse('Draw a desktop wallpaper of a mountain lake')).toEqual({
      settings: { aspectRatio: '16:9' },
      prompt: 'Draw a mountain lake',
    });
    expect(parse('a bakery storefront, website banner')).toMatchObject({
      settings: { aspectRatio: '21:9' },
    });
    expect(parse('a cat in portrait orientation')).toMatchObject({
      settings: { aspectRatio: '4:5' },
      prompt: 'a cat',
    });
  });

  it('keeps the article right when an adjective cue goes', () => {
    expect(parse('a 16:9 image of a fox')).toEqual({
      settings: { aspectRatio: '16:9' },
      prompt: 'an image of a fox',
    });
    expect(parse('a widescreen shot of a beach')).toEqual({
      settings: { aspectRatio: '16:9' },
      prompt: 'a shot of a beach',
    });
  });

  it('reads exact pixels and quality tiers', () => {
    expect(parse('a red car 1920x1080')).toEqual({
      settings: { width: 1920, height: 1080 },
      prompt: 'a red car',
    });
    expect(parse('a quick draft of a robot')).toEqual({
      settings: { quality: 'draft' },
      prompt: 'a robot',
    });
    expect(parse('a city map, hi-res, 3:2')).toEqual({
      settings: { quality: 'high', aspectRatio: '3:2' },
      prompt: 'a city map',
    });
  });

  it('leaves subjects that merely share the words alone', () => {
    for (const text of [
      'a portrait of a woman in a red coat',
      'a landscape painting of rolling hills',
      'a sign that says square deal',
      'a 3x3 grid of app icons',
      'a clock showing 10:30',
      'a banner hanging over the street',
      'an 8k ultra detailed castle',
    ]) {
      expect(parse(text)).toEqual({ settings: {}, prompt: text });
    }
  });

  it('leaves an empty prompt when the message was only settings', () => {
    expect(parse('make it 9:16')).toEqual({ settings: { aspectRatio: '9:16' }, prompt: '' });
  });

  it('keeps the first cue for each setting', () => {
    expect(parse('a tree, 9:16, no wait 16:9').settings).toEqual({ aspectRatio: '9:16' });
  });
});

describe('mergeImageSizeSettings', () => {
  it('lets a named shape replace the exact pixels below it, and the other way round', () => {
    expect(
      mergeImageSizeSettings({ width: 1024, height: 1024, model: 'flux' }, { aspectRatio: '9:16' }),
    ).toEqual({ model: 'flux', aspectRatio: '9:16' });
    expect(
      mergeImageSizeSettings({ aspectRatio: '9:16', quality: 'high' }, { width: 800, height: 600 }),
    ).toEqual({ width: 800, height: 600 });
  });

  it('keeps fields a later layer does not name', () => {
    expect(
      mergeImageSizeSettings(
        { aspectRatio: '16:9', quality: 'draft' },
        { quality: 'high' },
        undefined,
      ),
    ).toEqual({ aspectRatio: '16:9', quality: 'high' });
  });
});
