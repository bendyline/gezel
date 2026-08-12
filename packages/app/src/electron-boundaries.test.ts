import { describe, expect, it } from 'vitest';
import {
  daemonEntrypointArgument,
  isAllowedPreviewNavigation,
  isAllowedPreviewResourceRequest,
  isAllowedTopLevelNavigation,
  isExactApprovedPath,
  isExternalRendererNetworkRequest,
  isPreviewDocumentUrl,
} from './electron-boundaries.js';

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
