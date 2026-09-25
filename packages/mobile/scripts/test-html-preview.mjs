import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../../ui/package.json', import.meta.url));
const { chromium } = require('playwright');
const { createServer } = await import(require.resolve('vite'));
const root = fileURLToPath(new URL('..', import.meta.url));
const policy = (await readFile(new URL('../index.html', import.meta.url), 'utf8')).match(
  /content="([^"]*default-src[^"]*)"/,
)[1];
const snapshots = new Map();
const previewPolicy =
  "default-src 'none'; script-src data:; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
const server = await createServer({
  root,
  configFile: false,
  optimizeDeps: { noDiscovery: true, entries: [] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'offline-html-preview-test',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url === '/__publish') {
            let html = '';
            request.on('data', (chunk) => {
              html += chunk;
            });
            request.on('end', () => {
              const id = crypto.randomUUID();
              snapshots.set(id, html);
              response.setHeader('Content-Type', 'application/json');
              response.end(JSON.stringify({ url: `/__gezel_preview/${id}/index.html` }));
            });
            return;
          }
          if (request.url?.startsWith('/__gezel_preview/')) {
            const html = snapshots.get(request.url.split('/')[2]);
            response.setHeader('Content-Type', 'text/html');
            response.setHeader('Content-Security-Policy', previewPolicy);
            response.setHeader('Cache-Control', 'no-store');
            response.end(html ?? '');
            return;
          }
          if (request.url === '/__html_test') {
            response.setHeader('Content-Type', 'text/html');
            response.setHeader('Content-Security-Policy', policy);
            response.end('<!doctype html><title>Offline HTML preview test</title>');
            return;
          }
          next();
        });
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.addInitScript({
    path: fileURLToPath(new URL('../public/preview-isolation.js', import.meta.url)),
  });
  page.on('console', (message) => console.log('browser:', message.type(), message.text()));
  const network = [];
  await page.route('https://outside.invalid/**', (route) => {
    network.push(route.request().url());
    return route.abort();
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__html_test`);
  const result = await page.evaluate(async () => {
    const { buildOfflineHtmlPreview } = await import('/src/html-preview.ts');
    const files = {
      'game/index.html': `<!doctype html><link rel="stylesheet" href="assets/style.css"><button id="play" onclick="this.textContent='Played'">Play</button><img id="icon" src="assets/icon.svg"><script src="assets/game.js"></script><a href="https://outside.invalid/link">Outside</a><iframe src="https://outside.invalid/frame"></iframe><meta http-equiv="refresh" content="0;url=https://outside.invalid/refresh">`,
      'game/assets/style.css': '@import "theme.css"; #play{font-size:20px}',
      'game/assets/theme.css': '#play{color:rgb(12, 34, 56)}',
      'game/assets/icon.svg':
        '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>',
      'game/assets/game.js': `window.previewLoaded=true;try{parent.document.body.dataset.escaped='yes'}catch{};fetch('https://outside.invalid/fetch').catch(()=>{});const image=new Image();image.src='https://outside.invalid/image';window.open('https://outside.invalid/popup');parent.postMessage({previewTest:'ready',native:typeof window.Capacitor},'*');`,
    };
    const reads = [];
    const read = async (path) => {
      reads.push(path);
      if (!(path in files)) throw Error(`Unexpected read ${path}`);
      return new TextEncoder().encode(files[path]);
    };
    const publish = async (html) => {
      const reply = await fetch('/__publish', { method: 'POST', body: html });
      const data = await reply.json();
      return { url: new URL(data.url, location.href).href, dispose: () => {} };
    };
    const lease = await buildOfflineHtmlPreview('game/index.html', read, publish);
    window.previewLease = lease;
    window.previewFiles = files;
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.src = lease.url;
    document.body.append(frame);
    await new Promise((resolve, reject) => {
      frame.onload = resolve;
      setTimeout(() => reject(Error('Preview failed to load')), 5000);
    });
    if (document.body.dataset.escaped) throw Error('Preview accessed parent document');
    let denied = 0;
    for (const ref of [
      '../private.png',
      '%2e%2e/private.png',
      'assets/%2f../../private.png',
      'https://outside.invalid/file.js',
    ]) {
      try {
        await buildOfflineHtmlPreview(
          'game/index.html',
          async (path) =>
            path === 'game/index.html'
              ? new TextEncoder().encode(`<img src="${ref}">`)
              : read(path),
          publish,
        );
      } catch {
        denied++;
      }
    }
    return { reads, denied, url: lease.url };
  });
  const frame = page.frames().find((frame) => frame.url() === result.url);
  assert.ok(frame, 'reserved native-style preview response loaded');
  await frame.waitForFunction(() => window.previewLoaded === true);
  assert.equal(
    await frame.locator('#play').evaluate((element) => getComputedStyle(element).color),
    'rgb(12, 34, 56)',
  );
  await frame.locator('#play').click();
  assert.equal(await frame.locator('#play').textContent(), 'Played');
  assert.equal(await frame.locator('#icon').evaluate((element) => element.naturalWidth), 8);
  assert.equal(await frame.locator('a').getAttribute('href'), null);
  assert.equal(await frame.locator('iframe').count(), 0);
  assert.equal(
    await frame.evaluate(() => {
      const f = document.createElement('iframe');
      document.body.append(f);
      try {
        return typeof f.contentWindow.RTCPeerConnection;
      } catch {
        return 'denied';
      }
    }),
    'denied',
  );
  assert.deepEqual(
    await frame.evaluate(() => [typeof RTCPeerConnection, typeof URL.createObjectURL]),
    ['undefined', 'undefined'],
  );
  await page.evaluate(() => {
    window.addEventListener('message', (event) => {
      if (event.data?.nestedProbe) window.nestedProbe = event.data;
    });
  });
  await frame.evaluate(() => {
    const f = document.createElement('iframe');
    f.srcdoc = `<script src="data:text/javascript;base64,${btoa("top.postMessage({nestedProbe:true,rtc:typeof RTCPeerConnection},'*')")}"></script>`;
    document.body.append(f);
  });
  await page.waitForTimeout(100);
  assert.equal(
    (await page.evaluate(() => window.nestedProbe))?.rtc,
    'undefined',
    'nested script realm cannot regain networking',
  );
  await frame.evaluate(() => {
    location.href = 'https://outside.invalid/navigation';
  });
  await page.waitForTimeout(200);
  assert.ok(
    !frame.url().startsWith('https://outside.invalid'),
    'external frame navigation blocked',
  );
  assert.equal(result.denied, 4);
  assert.equal(network.length, 0, 'no external request authority');
  await page.evaluate(() => {
    window.previewLease.dispose();
    document.querySelector('iframe').remove();
  });
  console.log(JSON.stringify({ ok: true, checks: 14, reads: result.reads }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
