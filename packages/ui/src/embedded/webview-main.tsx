import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../assets/fonts/fonts.css';
import '../styles.css';
import './embedded.css';
import { EmbeddedChat } from './EmbeddedChat.js';

/**
 * Entry for the chat-only IIFE bundle the VS Code extension loads in
 * place of the daemon iframe. Boot contract — set by the webview-side
 * bridge (`packages/vscode/webview/bridge.ts`):
 *
 *   window.__GEZEL__ = {
 *     token, baseUrl, fetch,      // populated synchronously by bridge.ts
 *     projectId, gezelId,         // populated on `connection-ready`
 *   };
 *   window.dispatchEvent(new Event('gezel:boot'));  // fired on each
 *                                                   // connection-ready
 *
 * The bridge ships its postMessage-RPC fetch on `__GEZEL__.fetch` BEFORE
 * this bundle loads, so the `api` singleton in api.ts picks it up at
 * module init. baseUrl and token can be empty at init — the host
 * normalizes URLs and replaces the Authorization header before the
 * request actually leaves the extension. See packages/vscode/src/webview-rpc.ts.
 *
 * The React tree below waits in an "Open a workspace folder…" placeholder
 * until projectId is populated, then mounts EmbeddedChat — reusing the
 * exact same component the desktop SPA's `?embedded=chat` mode renders.
 */

function readBoot(): { projectId: string; gezelId: string } {
  const g = window.__GEZEL__;
  return {
    projectId: g?.projectId ?? '',
    gezelId: g?.gezelId ?? '',
  };
}

function WebviewChatRoot() {
  const [boot, setBoot] = useState(readBoot);
  useEffect(() => {
    const onBoot = () => setBoot(readBoot());
    window.addEventListener('gezel:boot', onBoot);
    return () => window.removeEventListener('gezel:boot', onBoot);
  }, []);
  if (!boot.projectId) {
    return (
      <div className="embedded-chat-status">
        Open a workspace folder, then click the Gezel icon to start chatting.
      </div>
    );
  }
  // `key` forces a fresh mount whenever the project switches — clears
  // any in-flight subscriptions, refetches project metadata, and
  // resets the timeline. Otherwise EmbeddedChat's internal effects
  // would have to handle every transient state itself.
  return (
    <EmbeddedChat
      key={`${boot.projectId}:${boot.gezelId}`}
      projectId={boot.projectId}
      gezelId={boot.gezelId}
      theme={null}
      accent={null}
      bg={null}
      fg={null}
      fontFamily={null}
      // VS Code's chat sidebar is ~250–500 px wide — the right-rail
      // commands / references panel can't fit. Compact mode drops it
      // entirely so the chat surface owns the full pane.
      compact
    />
  );
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root missing');
createRoot(rootEl).render(
  <StrictMode>
    <WebviewChatRoot />
  </StrictMode>,
);
