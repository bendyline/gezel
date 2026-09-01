import { describe, expect, it } from 'vitest';
import {
  PREVIEW_FRAME_INDETERMINATE,
  type PreviewFrameLike,
  daemonEntrypointArgument,
  isAllowedMicrophoneCapture,
  isAllowedPreviewNavigation,
  isAllowedPreviewResourceRequest,
  isAllowedRendererPermission,
  isAllowedTopLevelNavigation,
  isExactApprovedPath,
  isExternalRendererNetworkRequest,
  isPreviewDocumentUrl,
  normalizedDocumentUrl,
  previewExternalServicesForFrame,
} from './electron-boundaries.js';

function previewFrame(url: string, parent: PreviewFrameLike | null = null): PreviewFrameLike {
  return { isDestroyed: () => false, url, parent };
}

describe('daemon-entrypoint launch guard', () => {
  it('recognizes the daemon entrypoint on both path separators', () => {
    expect(
      daemonEntrypointArgument([
        '/Applications/Gezel.app/Contents/MacOS/Gezel',
        '/x/dist/bin/gezeld.js',
      ]),
    ).toBe('/x/dist/bin/gezeld.js');
    expect(
      daemonEntrypointArgument([
        'C:\\Program Files\\gezel\\gezel.exe',
        'C:\\x\\dist\\bin\\gezeld.js',
      ]),
    ).toBe('C:\\x\\dist\\bin\\gezeld.js');
    expect(daemonEntrypointArgument(['gezel', 'gezeld.js'])).toBe('gezeld.js');
  });

  it('ignores a normal application launch', () => {
    expect(daemonEntrypointArgument(['/Applications/Gezel.app/Contents/MacOS/Gezel'])).toBeNull();
    expect(
      daemonEntrypointArgument(['gezel', '--gezel-home=/tmp/h', '--gezel-packaged-smoke']),
    ).toBeNull();
  });

  it('never matches argv[0], which is the executable itself', () => {
    expect(daemonEntrypointArgument(['/x/dist/bin/gezeld.js'])).toBeNull();
  });

  it('does not match lookalike filenames', () => {
    expect(daemonEntrypointArgument(['gezel', '/x/not-gezeld.js'])).toBeNull();
    expect(daemonEntrypointArgument(['gezel', '/x/gezeld.js.map'])).toBeNull();
    expect(daemonEntrypointArgument(['gezel', '/x/gezeld.json'])).toBeNull();
  });
});

describe('Electron boundary policies', () => {
  it('allows only an audio-only microphone request from the top-level daemon UI', () => {
    const origin = 'https://127.0.0.1:4312';
    expect(isAllowedMicrophoneCapture('media', `${origin}/`, origin, true, ['audio'])).toBe(true);
    expect(isAllowedMicrophoneCapture('media', `${origin}/`, origin, true, ['video'])).toBe(false);
    expect(
      isAllowedMicrophoneCapture('media', `${origin}/`, origin, true, ['audio', 'video']),
    ).toBe(false);
    expect(
      isAllowedMicrophoneCapture('media', `${origin}/preview/cap/x`, origin, false, ['audio']),
    ).toBe(false);
    expect(
      isAllowedMicrophoneCapture('media', 'https://127.0.0.1.evil.test:4312/', origin, true, [
        'audio',
      ]),
    ).toBe(false);
    expect(isAllowedMicrophoneCapture('notifications', `${origin}/`, origin, true, ['audio'])).toBe(
      false,
    );
  });

  it('allows only the renderer capabilities Gezel uses', () => {
    const origin = 'https://127.0.0.1:4312';
    const trustedMainFrame = {
      isTrustedWebContents: true,
      requestingUrl: `${origin}/settings`,
      allowedOrigin: origin,
      isMainFrame: true,
    } as const;

    expect(
      isAllowedRendererPermission({
        ...trustedMainFrame,
        permission: 'media',
        mediaTypes: ['audio'],
      }),
    ).toBe(true);
    expect(
      isAllowedRendererPermission({
        ...trustedMainFrame,
        permission: 'clipboard-sanitized-write',
      }),
    ).toBe(true);

    for (const permission of [
      'clipboard-read',
      'deprecated-sync-clipboard-read',
      'geolocation',
      'notifications',
      'display-capture',
      'fullscreen',
      'hid',
      'idle-detection',
      'keyboardLock',
      'mediaKeySystem',
      'midi',
      'midiSysex',
      'openExternal',
      'pointerLock',
      'serial',
      'speaker-selection',
      'storage-access',
      'top-level-storage-access',
      'usb',
      'window-management',
      'fileSystem',
      'unknown',
      'future-electron-permission',
    ]) {
      expect(isAllowedRendererPermission({ ...trustedMainFrame, permission })).toBe(false);
    }
  });

  it('denies allowlisted capabilities to preview subframes and untrusted renderers', () => {
    const origin = 'https://127.0.0.1:4312';
    const previewUrl = `${origin}/preview/cap/workspace/default/site/index.html`;

    for (const request of [
      { permission: 'media', mediaTypes: ['audio'] },
      { permission: 'clipboard-sanitized-write' },
    ]) {
      expect(
        isAllowedRendererPermission({
          isTrustedWebContents: true,
          requestingUrl: previewUrl,
          allowedOrigin: origin,
          isMainFrame: false,
          ...request,
        }),
      ).toBe(false);
      expect(
        isAllowedRendererPermission({
          isTrustedWebContents: false,
          requestingUrl: `${origin}/`,
          allowedOrigin: origin,
          isMainFrame: true,
          ...request,
        }),
      ).toBe(false);
    }
  });

  it('denies allowlisted capabilities before connection and from lookalike origins', () => {
    const origin = 'https://127.0.0.1:4312';
    const request = {
      isTrustedWebContents: true,
      permission: 'clipboard-sanitized-write',
      isMainFrame: true,
    } as const;

    expect(
      isAllowedRendererPermission({
        ...request,
        requestingUrl: `${origin}/`,
        allowedOrigin: null,
      }),
    ).toBe(false);
    expect(
      isAllowedRendererPermission({
        ...request,
        requestingUrl: 'https://127.0.0.1.evil.test:4312/',
        allowedOrigin: origin,
      }),
    ).toBe(false);
    expect(
      isAllowedRendererPermission({
        ...request,
        requestingUrl: 'not a URL',
        allowedOrigin: origin,
      }),
    ).toBe(false);
  });

  it('allows only the daemon origin and the exact splash file', () => {
    const origin = 'https://127.0.0.1:4312';
    const splash = 'file:///opt/gezel/splash.html';
    expect(isAllowedTopLevelNavigation(`${origin}/settings`, origin, splash)).toBe(true);
    expect(isAllowedTopLevelNavigation(splash, origin, splash)).toBe(true);
    expect(isAllowedTopLevelNavigation('file:///etc/passwd', origin, splash)).toBe(false);
    expect(isAllowedTopLevelNavigation('data:text/html,pwned', origin, splash)).toBe(false);
    expect(isAllowedTopLevelNavigation('https://example.com', origin, splash)).toBe(false);
  });

  it('recognizes only preview URLs on the exact daemon origin', () => {
    const origin = 'https://127.0.0.1:4312';
    const preview = `${origin}/preview/cap/workspace/default/site/index.html`;
    expect(isPreviewDocumentUrl(preview, origin)).toBe(true);
    expect(isPreviewDocumentUrl(`${origin}/api/config`, origin)).toBe(false);
    expect(isPreviewDocumentUrl('https://127.0.0.1:4313/preview/cap/x', origin)).toBe(false);
    expect(isPreviewDocumentUrl('https://127.0.0.1.evil.test:4312/preview/cap/x', origin)).toBe(
      false,
    );
  });

  it('resolves a preview permission through descendant frames and normalized fragments', () => {
    const origin = 'https://127.0.0.1:4312';
    const preview = `${origin}/preview/cap/workspace/default/site/index.html`;
    const key = normalizedDocumentUrl(preview);
    expect(key).not.toBeNull();
    const permissions = new Map([[key!, true]]);
    const child = previewFrame('about:blank', previewFrame(`${preview}#section`, null));

    expect(previewExternalServicesForFrame(child, origin, permissions)).toBe(true);
  });

  it('fails closed when a preview has no trusted response permission', () => {
    const origin = 'https://127.0.0.1:4312';
    const preview = previewFrame(`${origin}/preview/cap/workspace/default/site/index.html`);

    expect(previewExternalServicesForFrame(preview, origin, new Map())).toBe(false);
  });

  it('keeps ordinary and absent frames outside preview policy', () => {
    const origin = 'https://127.0.0.1:4312';
    const permissions = new Map<string, boolean>();

    expect(previewExternalServicesForFrame(null, origin, permissions)).toBeNull();
    expect(
      previewExternalServicesForFrame(previewFrame(`${origin}/settings`), origin, permissions),
    ).toBeNull();
  });

  it('fails closed before reading properties from a destroyed frame', () => {
    const destroyed = {
      isDestroyed: () => true,
      get url(): string {
        throw new Error('disposed url must not be read');
      },
      get parent(): PreviewFrameLike | null {
        throw new Error('disposed parent must not be read');
      },
    } satisfies PreviewFrameLike;

    expect(previewExternalServicesForFrame(destroyed, 'https://127.0.0.1:4312', new Map())).toBe(
      PREVIEW_FRAME_INDETERMINATE,
    );
  });

  it('fails closed when Electron disposes a frame during property access', () => {
    const throwingUrl = {
      isDestroyed: () => false,
      get url(): string {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed');
      },
      parent: null,
    } satisfies PreviewFrameLike;
    const throwingParent = {
      isDestroyed: () => false,
      url: 'about:blank',
      get parent(): PreviewFrameLike | null {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed');
      },
    } satisfies PreviewFrameLike;
    const permissions = new Map<string, boolean>();

    expect(
      previewExternalServicesForFrame(throwingUrl, 'https://127.0.0.1:4312', permissions),
    ).toBe(PREVIEW_FRAME_INDETERMINATE);
    expect(
      previewExternalServicesForFrame(throwingParent, 'https://127.0.0.1:4312', permissions),
    ).toBe(PREVIEW_FRAME_INDETERMINATE);
  });

  it('keeps preview navigation capability-pinned in every policy mode', () => {
    const origin = 'https://127.0.0.1:4312';
    expect(isAllowedPreviewNavigation(`${origin}/preview/cap/workspace/p/next.html`, origin)).toBe(
      true,
    );
    expect(isAllowedPreviewNavigation(`${origin}/settings`, origin)).toBe(false);
    expect(isAllowedPreviewNavigation('https://example.com/', origin)).toBe(false);
    expect(isAllowedPreviewNavigation('data:text/html,pwned', origin)).toBe(false);
  });

  it('blocks strict preview egress but permits local assets and inert URLs', () => {
    const origin = 'https://127.0.0.1:4312';
    expect(isAllowedPreviewResourceRequest(`${origin}/preview/cap/app.js`, origin, false)).toBe(
      true,
    );
    expect(isAllowedPreviewResourceRequest('wss://127.0.0.1:4312/events', origin, false)).toBe(
      true,
    );
    expect(isAllowedPreviewResourceRequest('https://example.com/app.js', origin, false)).toBe(
      false,
    );
    expect(isAllowedPreviewResourceRequest('ws://127.0.0.1:4312/events', origin, false)).toBe(
      false,
    );
    expect(isAllowedPreviewResourceRequest('file:///etc/passwd', origin, false)).toBe(false);
    expect(isAllowedPreviewResourceRequest('data:image/png;base64,AA==', origin, false)).toBe(true);
    expect(isAllowedPreviewResourceRequest('blob:null/id', origin, false)).toBe(true);
  });

  it('allows ordinary network resources only in External services mode', () => {
    const origin = 'https://127.0.0.1:4312';
    for (const url of [
      'https://cdn.example/app.js',
      'http://api.example/data',
      'wss://socket.example/events',
      'ws://127.0.0.1:9999/events',
    ]) {
      expect(isAllowedPreviewResourceRequest(url, origin, true)).toBe(true);
    }
    expect(isAllowedPreviewResourceRequest('file:///tmp/secret', origin, true)).toBe(false);
    expect(isAllowedPreviewResourceRequest('javascript:alert(1)', origin, true)).toBe(false);
    expect(isAllowedPreviewResourceRequest('custom://handler', origin, true)).toBe(false);
  });

  it('classifies only off-daemon network traffic as external renderer egress', () => {
    const origin = 'https://127.0.0.1:4312';
    expect(isExternalRendererNetworkRequest(`${origin}/api/config`, origin)).toBe(false);
    expect(isExternalRendererNetworkRequest('wss://127.0.0.1:4312/events', origin)).toBe(false);
    expect(isExternalRendererNetworkRequest('https://example.com/pixel', origin)).toBe(true);
    expect(isExternalRendererNetworkRequest('ws://127.0.0.1:9999/events', origin)).toBe(true);
    expect(isExternalRendererNetworkRequest('data:image/png;base64,AA==', origin)).toBe(false);
    expect(isExternalRendererNetworkRequest('blob:null/id', origin)).toBe(false);
    expect(isExternalRendererNetworkRequest('file:///tmp/secret', origin)).toBe(false);
    expect(isExternalRendererNetworkRequest('https://example.com', null)).toBe(true);
  });

  it('approves exact roots, not their parents or children', () => {
    const approved = ['C:\\Users\\A\\.gezel\\projects'];
    expect(isExactApprovedPath('c:\\users\\a\\.gezel\\projects', approved, 'win32')).toBe(true);
    expect(isExactApprovedPath('C:\\Users\\A\\.gezel', approved, 'win32')).toBe(false);
    expect(isExactApprovedPath('C:\\Users\\A\\.gezel\\projects\\secret', approved, 'win32')).toBe(
      false,
    );
  });
});
