import type { Session, WebContents } from 'electron';
import { isAllowedRendererPermission } from './electron-boundaries.js';

export type RendererPermissionCheckHandler = NonNullable<
  Parameters<Session['setPermissionCheckHandler']>[0]
>;
export type RendererPermissionRequestHandler = NonNullable<
  Parameters<Session['setPermissionRequestHandler']>[0]
>;

export interface RendererPermissionSession {
  setPermissionCheckHandler(handler: RendererPermissionCheckHandler | null): void;
  setPermissionRequestHandler(handler: RendererPermissionRequestHandler | null): void;
}

/**
 * Install Gezel's fail-closed browser-permission boundary on one Electron
 * session. The origin is resolved for every decision because a supervised
 * daemon restart can rotate the loopback port and bearer-token connection.
 */
export function installRendererPermissionPolicy(
  rendererSession: RendererPermissionSession,
  trustedWebContents: WebContents,
  allowedOrigin: () => string | null,
): void {
  rendererSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) =>
    isAllowedRendererPermission({
      isTrustedWebContents: webContents === trustedWebContents,
      permission,
      requestingUrl: details.requestingUrl ?? requestingOrigin,
      allowedOrigin: allowedOrigin(),
      isMainFrame: details.isMainFrame,
      mediaTypes: details.mediaType ? [details.mediaType] : undefined,
    }),
  );

  rendererSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(
      isAllowedRendererPermission({
        isTrustedWebContents: webContents === trustedWebContents,
        permission,
        requestingUrl: details.requestingUrl,
        allowedOrigin: allowedOrigin(),
        isMainFrame: details.isMainFrame,
        mediaTypes:
          permission === 'media'
            ? (details as Electron.MediaAccessPermissionRequest).mediaTypes
            : undefined,
      }),
    );
  });
}
