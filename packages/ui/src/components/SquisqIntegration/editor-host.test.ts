import { afterEach, describe, expect, it } from 'vitest';
import { gezelEditorHost } from './editor-host.js';

describe('gezelEditorHost', () => {
  const original = window.__GEZEL__?.platform;
  afterEach(() => {
    if (window.__GEZEL__) window.__GEZEL__.platform = original;
  });

  function onPlatform(platform: string | undefined) {
    if (!window.__GEZEL__) throw new Error('test setup installs window.__GEZEL__');
    window.__GEZEL__.platform = platform;
    return gezelEditorHost();
  }

  it('turns off Narrate Pop out inside the phone app', () => {
    expect(onPlatform('mobile').allowNarratePopOut).toBe(false);
    expect(onPlatform('ios').allowNarratePopOut).toBe(false);
    expect(onPlatform('android').allowNarratePopOut).toBe(false);
  });

  it('keeps Pop out on the desktop and in a browser', () => {
    expect(onPlatform('darwin').allowNarratePopOut).toBe(true);
    expect(onPlatform('win32').allowNarratePopOut).toBe(true);
    expect(onPlatform('browser').allowNarratePopOut).toBe(true);
    expect(onPlatform(undefined).allowNarratePopOut).toBe(true);
  });
});
