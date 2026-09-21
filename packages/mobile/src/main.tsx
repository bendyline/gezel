import content from 'virtual:gezel-portable-content';
import { PortableProductService, PortableStore } from '@bendyline/gezel/runtime';
import { version } from '../../core/package.json';
import { ProductModelSettings } from './ProductModelSettings.js';
import { createBrowserHost } from './browser-host.js';
import { createOfflineHtmlPreview } from './html-preview.js';
import { createNativeHost, isNativeHost } from './native.js';
import { createMobileScripts } from './scripts.js';
import './product-host.css';

async function boot() {
  const host = isNativeHost() ? createNativeHost() : createBrowserHost();
  const token = crypto.randomUUID();
  const store = new PortableStore({ files: host.files, version });
  const htmlPreview = Boolean(
    host.native &&
      host.publishHtmlPreview &&
      (await host.previewAvailability?.().catch(() => false)),
  );
  const service = new PortableProductService(store, host.inference, token, {
    htmlPreview,
    speech: host.speech,
  });
  service.setScripts(createMobileScripts(store));
  service.setContent(content);
  service.setNetworkCancellation(async () => {
    await host.cancelModelSourceResolution();
    for (const download of await host.listModelDownloads())
      if (['queued', 'downloading', 'verifying'].includes(download.state))
        await host.cancelModelDownload(download.id);
  });
  await service.initialize();

  // api.ts reads this synchronously on import. Install the host before loading
  // the same entry point Electron uses, including its styles/editor workers.
  window.__GEZEL__ = {
    token,
    baseUrl: 'https://gezel.local',
    fetch: service.fetch,
    platform: host.native ? 'mobile' : 'browser',
    capabilities: service.capabilities,
    saveExportedFile: host.saveExportedFile,
    createHtmlPreview:
      htmlPreview && host.publishHtmlPreview
        ? createOfflineHtmlPreview(service.fetch, token, host.publishHtmlPreview)
        : undefined,
    renderModelSettings: () => (
      <ProductModelSettings host={host} service={service} models={content.models} />
    ),
  };
  await import('../../ui/src/main.js');
  const viewport = window.visualViewport;
  const resize = () => {
    if (viewport)
      document.documentElement.style.setProperty('--app-viewport-height', `${viewport.height}px`);
  };
  viewport?.addEventListener('resize', resize);
  resize();
  window.addEventListener('pagehide', () => {
    void service.suspend().catch(() => {});
  });
  window.addEventListener('pageshow', () => service.resume());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void service.suspend().catch(() => {});
    else service.resume();
  });
}
void boot().catch((error) => {
  const root = document.getElementById('root');
  if (!root) return;
  const message = document.createElement('p');
  message.setAttribute('role', 'alert');
  message.textContent = `Gezel could not open your saved work: ${error instanceof Error ? error.message : String(error)}. Close and reopen the app to try again.`;
  root.replaceChildren(message);
});
