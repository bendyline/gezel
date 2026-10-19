import type { InstalledImageModel } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  effectiveImageSettings,
  imageSendFields,
  imageSettingsReadout,
} from './composer-image-settings.js';

const flux: InstalledImageModel = {
  id: 'flux-2-klein-4b-q4',
  name: 'FLUX.2 Klein',
  approxSizeBytes: 1,
  installedAt: '2026-10-19T00:00:00Z',
  kind: 'local',
  defaultSidePx: 1024,
  widthRange: { min: 512, max: 2048 },
  heightRange: { min: 512, max: 2048 },
};

describe('composer image settings', () => {
  it('layers defaults, picks and the message the way the daemon does', () => {
    expect(
      effectiveImageSettings({
        defaults: { width: 1024, height: 1024, steps: 4 },
        picks: { quality: 'draft' },
        cues: { aspectRatio: '9:16' },
      }),
    ).toEqual({ quality: 'draft', aspectRatio: '9:16' });
  });

  it('reads out the shape, the pixels and the model', () => {
    expect(imageSettingsReadout({ aspectRatio: '9:16' }, flux)).toBe(
      '9:16 · 768×1344 · FLUX.2 Klein',
    );
    expect(imageSettingsReadout({}, flux)).toBe('1:1 · 1024×1024 · FLUX.2 Klein');
    expect(imageSettingsReadout({ quality: 'high', aspectRatio: '16:9' }, flux)).toBe(
      '16:9 · 2048×1152 · high · FLUX.2 Klein',
    );
    expect(
      imageSettingsReadout(
        { aspectRatio: '9:16' },
        { ...flux, kind: 'cloud', defaultSidePx: undefined, name: 'GPT Image 2' },
      ),
    ).toBe('9:16 · GPT Image 2');
  });

  it('sends the picks, and says when the person dismissed what the message named', () => {
    expect(imageSendFields({ picks: {}, cuesDismissed: false })).toEqual({});
    expect(imageSendFields({ picks: { aspectRatio: '4:5' }, cuesDismissed: true })).toEqual({
      imageSettings: { aspectRatio: '4:5' },
      imageCues: 'off',
    });
  });
});
