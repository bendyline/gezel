import { describe, expect, it } from 'vitest';
import {
  fitImageSizeToRange,
  imageModelDefaultSide,
  nearestAspectRatio,
  resolveImageSize,
} from './image-size.js';

const flux = {
  defaultSidePx: 1024,
  widthRange: { min: 512, max: 2048 },
  heightRange: { min: 512, max: 2048 },
};
const iris = {
  defaultSidePx: 1024,
  widthRange: { min: 512, max: 1536 },
  heightRange: { min: 512, max: 1536 },
};
const ming = {
  defaultSidePx: 1024,
  widthRange: { min: 1024, max: 2048 },
  heightRange: { min: 1024, max: 2048 },
};
const sd15 = {
  defaultSidePx: 512,
  widthRange: { min: 256, max: 768 },
  heightRange: { min: 256, max: 768 },
};

describe('imageModelDefaultSide', () => {
  it('renders megapixel-trained models at 1024 and the rest at 512', () => {
    expect(imageModelDefaultSide('flux-2-klein-4b-q4')).toBe(1024);
    expect(imageModelDefaultSide('sd-1.5')).toBe(512);
    expect(imageModelDefaultSide('sdxl-turbo')).toBe(512);
    expect(imageModelDefaultSide(undefined)).toBe(512);
  });
});

describe('resolveImageSize', () => {
  it('renders the trained square when nothing is asked', () => {
    expect(resolveImageSize({}, flux)).toEqual({ width: 1024, height: 1024 });
    expect(resolveImageSize({}, sd15)).toEqual({ width: 512, height: 512 });
  });

  it('keeps the trained area in the asked shape, on multiples of 64', () => {
    expect(resolveImageSize({ aspectRatio: '9:16' }, flux)).toEqual({ width: 768, height: 1344 });
    expect(resolveImageSize({ aspectRatio: '16:9' }, flux)).toEqual({ width: 1344, height: 768 });
    expect(resolveImageSize({ aspectRatio: '4:5' }, flux)).toEqual({ width: 896, height: 1152 });
    expect(resolveImageSize({ aspectRatio: '21:9' }, flux)).toEqual({ width: 1536, height: 640 });
    expect(resolveImageSize({ aspectRatio: '9:16' }, sd15)).toEqual({ width: 384, height: 704 });
  });

  it('scales the area by quality and holds it to the range', () => {
    expect(resolveImageSize({ aspectRatio: '9:16', quality: 'high' }, flux)).toEqual({
      width: 1152,
      height: 2048,
    });
    expect(resolveImageSize({ aspectRatio: '9:16', quality: 'high' }, iris)).toEqual({
      width: 896,
      height: 1536,
    });
    expect(resolveImageSize({ quality: 'high' }, sd15)).toEqual({ width: 768, height: 768 });
    expect(resolveImageSize({ aspectRatio: '16:9', quality: 'high' }, sd15)).toEqual({
      width: 768,
      height: 448,
    });
  });

  it('raises a draft to the model minimum, keeping its shape, on multiples of 64', () => {
    const sdxlTurbo = {
      defaultSidePx: 512,
      widthRange: { min: 512, max: 1024 },
      heightRange: { min: 512, max: 1024 },
    };
    // sd-server rounds an SDXL size up to 64: 512x944 rendered 512x960.
    expect(resolveImageSize({ aspectRatio: '9:16' }, sdxlTurbo)).toEqual({
      width: 512,
      height: 960,
    });
    expect(resolveImageSize({ quality: 'draft' }, flux)).toEqual({ width: 512, height: 512 });
    expect(resolveImageSize({ quality: 'draft' }, sd15)).toEqual({ width: 256, height: 256 });
    expect(resolveImageSize({ aspectRatio: '9:16' }, ming)).toEqual({ width: 1024, height: 1792 });
  });

  it('lets explicit pixels win over shape and quality', () => {
    expect(
      resolveImageSize({ width: 1000, height: 600, aspectRatio: '9:16', quality: 'draft' }, flux),
    ).toEqual({ width: 1000, height: 600 });
  });

  it('derives a missing side from the ratio, or falls back to the default side', () => {
    expect(resolveImageSize({ width: 1024, aspectRatio: '16:9' }, flux)).toEqual({
      width: 1024,
      height: 576,
    });
    expect(resolveImageSize({ height: 1024, aspectRatio: '3:2' }, flux)).toEqual({
      width: 1536,
      height: 1024,
    });
    expect(resolveImageSize({ width: 768 }, flux)).toEqual({ width: 768, height: 1024 });
  });
});

describe('nearestAspectRatio', () => {
  it('names the closest ratio', () => {
    expect(nearestAspectRatio(768, 1344)).toBe('9:16');
    expect(nearestAspectRatio(1920, 1080)).toBe('16:9');
    expect(nearestAspectRatio(1000, 1000)).toBe('1:1');
    expect(nearestAspectRatio(1536, 640)).toBe('21:9');
  });
});

describe('fitImageSizeToRange', () => {
  it('leaves a size inside the range untouched', () => {
    expect(fitImageSizeToRange({ width: 1200, height: 1100 }, ming)).toEqual({
      width: 1200,
      height: 1100,
    });
    expect(fitImageSizeToRange({}, ming)).toEqual({});
  });

  it('scales a too-small or too-large request into range, keeping the shape', () => {
    expect(fitImageSizeToRange({ width: 768, height: 768 }, ming)).toEqual({
      width: 1024,
      height: 1024,
    });
    expect(fitImageSizeToRange({ width: 768, height: 448 }, ming)).toEqual({
      width: 1728,
      height: 1024,
    });
    expect(fitImageSizeToRange({ width: 1024, height: 1024 }, sd15)).toEqual({
      width: 768,
      height: 768,
    });
  });

  it('clamps a lone side, and clamps both when the shape cannot fit', () => {
    expect(fitImageSizeToRange({ width: 512 }, ming)).toEqual({ width: 1024 });
    expect(fitImageSizeToRange({ width: 3000, height: 300 }, sd15)).toEqual({
      width: 768,
      height: 256,
    });
  });
});
