import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { createBrowserHost } from './browser-host.js';
import { createNativeHost, isNativeHost } from './native.js';
import { createWorkerClient } from './worker-client.js';
import '../../ui/src/assets/fonts/ui-fonts.css';
import '../../ui/src/styles/foundation.css';
import '../../ui/src/styles/controls-handbook-and-admin.css';
import '../../ui/src/styles/app-shell.css';
import './style.css';

const host = isNativeHost() ? createNativeHost() : createBrowserHost();
document.documentElement.dataset.sidebarSide = 'right';
const client = createWorkerClient(host);
const root = document.getElementById('root');
if (!root) throw new Error('The mobile app root is missing');
createRoot(root).render(<App client={client} host={host} />);
const viewport = window.visualViewport;
function resizeToKeyboard() {
  if (viewport) root?.style.setProperty('--mobile-height', `${viewport.height}px`);
}
viewport?.addEventListener('resize', resizeToKeyboard);
resizeToKeyboard();
window.addEventListener('pagehide', () => {
  void client.cancel().catch(() => {});
});
