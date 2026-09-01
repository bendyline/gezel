import type {
  MediaAccessPermissionRequest,
  PermissionCheckHandlerHandlerDetails,
  PermissionRequest,
  WebContents,
} from 'electron';
import { describe, expect, it } from 'vitest';
import {
  type RendererPermissionCheckHandler,
  type RendererPermissionRequestHandler,
  type RendererPermissionSession,
  installRendererPermissionPolicy,
} from './renderer-permissions.js';

const ORIGIN = 'https://127.0.0.1:4312';

function harness(initialOrigin: string | null = ORIGIN): {
  trusted: WebContents;
  other: WebContents;
  setOrigin(origin: string | null): void;
  check: RendererPermissionCheckHandler;
  request: RendererPermissionRequestHandler;
} {
  let checkHandler: RendererPermissionCheckHandler | null = null;
  let requestHandler: RendererPermissionRequestHandler | null = null;
  let currentOrigin = initialOrigin;
  const session: RendererPermissionSession = {
    setPermissionCheckHandler: (handler) => {
      checkHandler = handler;
    },
    setPermissionRequestHandler: (handler) => {
      requestHandler = handler;
    },
  };
  const trusted = {} as WebContents;
  const other = {} as WebContents;

  installRendererPermissionPolicy(session, trusted, () => currentOrigin);
  if (!checkHandler || !requestHandler) throw new Error('permission handlers were not installed');

  return {
    trusted,
    other,
    setOrigin: (origin) => {
      currentOrigin = origin;
    },
    check: checkHandler,
    request: requestHandler,
  };
}

function checkDetails(
  overrides: Partial<PermissionCheckHandlerHandlerDetails> = {},
): PermissionCheckHandlerHandlerDetails {
  return {
    requestingUrl: `${ORIGIN}/settings`,
    isMainFrame: true,
    ...overrides,
  };
}

function requestDecision(
  handler: RendererPermissionRequestHandler,
  webContents: WebContents,
  permission: Parameters<RendererPermissionRequestHandler>[1],
  details: PermissionRequest | MediaAccessPermissionRequest,
): boolean {
  let decision: boolean | undefined;
  handler(
    webContents,
    permission,
    (granted) => {
      decision = granted;
    },
    details,
  );
  if (decision === undefined) throw new Error('permission callback was not invoked');
  return decision;
}

describe('renderer permission handler wiring', () => {
  it('allows only audio and sanitized clipboard writes from the trusted main frame', () => {
    const { trusted, check, request } = harness();

    expect(check(trusted, 'media', ORIGIN, checkDetails({ mediaType: 'audio' }))).toBe(true);
    expect(check(trusted, 'clipboard-sanitized-write', ORIGIN, checkDetails())).toBe(true);
    expect(
      requestDecision(request, trusted, 'media', {
        requestingUrl: `${ORIGIN}/settings`,
        isMainFrame: true,
        mediaTypes: ['audio'],
      }),
    ).toBe(true);
    expect(
      requestDecision(request, trusted, 'clipboard-sanitized-write', {
        requestingUrl: `${ORIGIN}/settings`,
        isMainFrame: true,
      }),
    ).toBe(true);
  });

  it('denies representative non-media permissions in both Electron handlers', () => {
    const { trusted, check, request } = harness();
    const permissions = ['clipboard-read', 'geolocation', 'notifications', 'midi'] as const;

    for (const permission of permissions) {
      expect(check(trusted, permission, ORIGIN, checkDetails())).toBe(false);
      expect(
        requestDecision(request, trusted, permission, {
          requestingUrl: `${ORIGIN}/settings`,
          isMainFrame: true,
        }),
      ).toBe(false);
    }
  });

  it('denies previews, other WebContents, wrong origins, and camera capture', () => {
    const { trusted, other, check, request } = harness();
    const preview = `${ORIGIN}/preview/cap/workspace/default/site/index.html`;

    expect(
      check(
        trusted,
        'clipboard-sanitized-write',
        ORIGIN,
        checkDetails({
          requestingUrl: preview,
          isMainFrame: false,
        }),
      ),
    ).toBe(false);
    expect(check(other, 'clipboard-sanitized-write', ORIGIN, checkDetails())).toBe(false);
    expect(
      check(
        trusted,
        'clipboard-sanitized-write',
        'https://127.0.0.1.evil.test:4312',
        checkDetails({ requestingUrl: undefined }),
      ),
    ).toBe(false);
    expect(check(trusted, 'media', ORIGIN, checkDetails({ mediaType: 'video' }))).toBe(false);
    expect(
      requestDecision(request, trusted, 'clipboard-sanitized-write', {
        requestingUrl: preview,
        isMainFrame: false,
      }),
    ).toBe(false);
    expect(
      requestDecision(request, trusted, 'media', {
        requestingUrl: preview,
        isMainFrame: false,
        mediaTypes: ['audio'],
      }),
    ).toBe(false);
  });

  it('resolves the current daemon origin for every decision and fails closed while disconnected', () => {
    const policy = harness(null);

    expect(policy.check(policy.trusted, 'clipboard-sanitized-write', ORIGIN, checkDetails())).toBe(
      false,
    );
    policy.setOrigin(ORIGIN);
    expect(policy.check(policy.trusted, 'clipboard-sanitized-write', ORIGIN, checkDetails())).toBe(
      true,
    );
  });
});
