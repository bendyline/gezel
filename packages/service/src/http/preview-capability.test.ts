import { describe, expect, it } from 'vitest';
import {
  PreviewCapabilityStore,
  normalizePreviewPath,
  previewCapabilityPath,
} from './preview-capability.js';

describe('PreviewCapabilityStore', () => {
  it('mints high-entropy tokens bound to project, source, and entry subtree', () => {
    const store = new PreviewCapabilityStore();
    const minted = store.mint({
      source: 'workspace',
      projectId: 'project-a',
      entryPath: 'site/index.html',
    });
    expect(minted.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(minted.scopePath).toBe('site');
    expect(
      store.authorize({
        token: minted.token,
        source: 'workspace',
        projectId: 'project-a',
        path: 'site/app.js',
      }),
    ).toEqual({ ok: true, path: 'site/app.js' });
    expect(
      store.authorize({
        token: minted.token,
        source: 'workspace',
        projectId: 'project-b',
        path: 'site/app.js',
      }),
    ).toEqual({ ok: false, reason: 'scope' });
    expect(
      store.authorize({
        token: minted.token,
        source: 'artifacts',
        projectId: 'project-a',
        path: 'site/app.js',
      }),
    ).toEqual({ ok: false, reason: 'scope' });
    expect(
      store.authorize({
        token: minted.token,
        source: 'workspace',
        projectId: 'project-a',
        path: 'secret.txt',
      }),
    ).toEqual({ ok: false, reason: 'scope' });
  });

  it('supports only explicit server-derived cross-source reads', () => {
    const store = new PreviewCapabilityStore();
    const minted = store.mint({
      source: 'type',
      projectId: 'project-a',
      entryPath: 'dashboard/index.html',
      additionalScopes: [{ source: 'workspace', path: 'progress.json' }],
    });
    expect(
      store.authorize({
        token: minted.token,
        source: 'workspace',
        projectId: 'project-a',
        path: 'progress.json',
      }).ok,
    ).toBe(true);
    expect(
      store.authorize({
        token: minted.token,
        source: 'workspace',
        projectId: 'project-a',
        path: 'other.json',
      }),
    ).toEqual({ ok: false, reason: 'scope' });
  });

  it('uses a sliding idle expiry with a bounded absolute lifetime', () => {
    let now = 0;
    const store = new PreviewCapabilityStore({
      ttlMs: 100,
      absoluteTtlMs: 250,
      now: () => now,
    });
    const minted = store.mint({ source: 'artifacts', projectId: 'p', entryPath: 'index.html' });

    now = 90;
    expect(
      store.authorize({ token: minted.token, source: 'artifacts', projectId: 'p', path: 'a.js' })
        .ok,
    ).toBe(true);
    now = 180;
    expect(
      store.authorize({ token: minted.token, source: 'artifacts', projectId: 'p', path: 'b.js' })
        .ok,
    ).toBe(true);
    now = 249;
    expect(
      store.authorize({ token: minted.token, source: 'artifacts', projectId: 'p', path: 'c.js' })
        .ok,
    ).toBe(true);
    now = 250;
    expect(
      store.authorize({ token: minted.token, source: 'artifacts', projectId: 'p', path: 'd.js' }),
    ).toEqual({ ok: false, reason: 'expired' });
  });

  it('does not let out-of-scope probes refresh the idle lease', () => {
    let now = 0;
    const store = new PreviewCapabilityStore({
      ttlMs: 100,
      absoluteTtlMs: 1_000,
      now: () => now,
    });
    const minted = store.mint({
      source: 'workspace',
      projectId: 'p',
      entryPath: 'site/index.html',
    });
    now = 90;
    expect(
      store.authorize({ token: minted.token, source: 'workspace', projectId: 'p', path: 'nope' }),
    ).toEqual({ ok: false, reason: 'scope' });
    now = 101;
    expect(
      store.authorize({
        token: minted.token,
        source: 'workspace',
        projectId: 'p',
        path: 'site/index.html',
      }),
    ).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('normalizePreviewPath', () => {
  it('normalizes separators but refuses absolute and traversal paths', () => {
    expect(normalizePreviewPath('site\\assets\\app.js')).toBe('site/assets/app.js');
    expect(normalizePreviewPath('./site/index.html')).toBe('site/index.html');
    expect(normalizePreviewPath('../secret')).toBeNull();
    expect(normalizePreviewPath('site/../secret')).toBeNull();
    expect(normalizePreviewPath('/etc/passwd')).toBeNull();
    expect(normalizePreviewPath('C:\\secret')).toBeNull();
  });
});

describe('previewCapabilityPath', () => {
  it('uses the shared output-pane/browser-preview route shape', () => {
    expect(
      previewCapabilityPath({
        token: 'a/b',
        source: 'workspace',
        projectId: 'project one',
        entryPath: 'site/index file.html',
      }),
    ).toBe('/preview/a%2Fb/workspace/project%20one/site/index%20file.html');
  });
});
