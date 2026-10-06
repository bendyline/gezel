import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../../ui/package.json', import.meta.url));
const { chromium, webkit } = require('playwright');
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
  // TypeScript and module scripts, compiled by script-runtime's own compiler
  // and linked into one deferred classic script inside the same snapshot.
  const { compilePreviewModule } = await import(
    new URL('../../script-runtime/dist/preview-module.js', import.meta.url)
  );
  await page.exposeFunction('gezelCompilePreview', (modules) =>
    modules.map(({ path, source }) => ({
      path,
      ...compilePreviewModule(source, path, 'commonjs'),
    })),
  );
  const modular = await page.evaluate(async () => {
    const { buildOfflineHtmlPreview } = await import('/src/html-preview.ts');
    const encode = (text) => new TextEncoder().encode(text);
    const files = {
      'tanks/index.html': `<!doctype html><head><script type="module" src="src/main.ts"></script><script type="module">import { units } from './src/units'; window.inlineUnits = units.length;</script></head><body><canvas id="board"></canvas></body>`,
      'tanks/src/main.ts': [
        "import { Engine } from './engine';",
        "import type { Missing } from './types';",
        "import { units } from './units';",
        "import level from './levels/one.json';",
        "import sprite from './sprites/tank.svg';",
        "import './style.css';",
        "const board = document.getElementById('board') as HTMLCanvasElement;",
        'const engine: Engine = new Engine(units);',
        'const unused: Missing | undefined = undefined;',
        '(window as any).previewModules = { board: board?.tagName, ticks: engine.tick(), units: units.length, level: level.name, sprite: sprite.slice(0, 18), unused };',
      ].join('\n'),
      'tanks/src/engine.ts':
        "import { units } from './units/index.js';\n(window as any).engineRuns = ((window as any).engineRuns ?? 0) + 1;\nexport class Engine { constructor(private list: string[]) {} tick(): number { return this.list.length + units.length; } }",
      'tanks/src/units/index.ts': "export const units: string[] = ['scout', 'heavy'];",
      'tanks/src/levels/one.json': '{"name":"Ardennes"}',
      'tanks/src/sprites/tank.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
      'tanks/src/style.css': '#board{width:33px}',
    };
    const read = async (path) => {
      if (!(path in files)) throw Error(`Could not read preview file ${path} (404)`);
      return encode(files[path]);
    };
    const publish = async (html) => {
      const reply = await fetch('/__publish', { method: 'POST', body: html });
      const data = await reply.json();
      return { url: new URL(data.url, location.href).href, dispose: () => {} };
    };
    const compileModules = () => ({
      compile: (modules) => window.gezelCompilePreview(modules),
      dispose() {},
    });
    const lease = await buildOfflineHtmlPreview('tanks/index.html', read, publish, compileModules);
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.src = lease.url;
    document.body.append(frame);
    await new Promise((resolve, reject) => {
      frame.onload = resolve;
      setTimeout(() => reject(Error('Module preview failed to load')), 5000);
    });
    const problems = [];
    for (const source of [
      "import { Game } from './game/Game';\nnew Game();",
      "import Phaser from 'phaser';\nnew Phaser.Game();",
    ]) {
      try {
        await buildOfflineHtmlPreview(
          'tanks/index.html',
          async (path) =>
            path === 'tanks/index.html'
              ? encode('<script type="module" src="src/main.ts"></script>')
              : path === 'tanks/src/main.ts'
                ? encode(source)
                : read(path),
          publish,
          compileModules,
        );
      } catch (error) {
        problems.push(error.message);
      }
    }
    return { url: lease.url, problems };
  });
  const tanks = page.frames().find((frame) => frame.url() === modular.url);
  assert.ok(tanks, 'module preview loaded');
  await tanks.waitForFunction(() => window.previewModules !== undefined);
  assert.deepEqual(await tanks.evaluate(() => window.previewModules), {
    board: 'CANVAS',
    ticks: 4,
    units: 2,
    level: 'Ardennes',
    sprite: 'data:image/svg+xml',
    unused: undefined,
  });
  assert.equal(await tanks.evaluate(() => window.inlineUnits), 2, 'inline module shares imports');
  assert.equal(await tanks.evaluate(() => window.engineRuns), 1, 'each module runs once');
  assert.equal(
    await tanks.locator('#board').evaluate((element) => getComputedStyle(element).width),
    '33px',
  );
  assert.deepEqual(modular.problems, [
    "tanks/src/main.ts imports ./game/Game, which isn't in the project.",
    'tanks/src/main.ts imports the npm package "phaser". A preview runs only files in the project, so add the library\'s file to the project and import it by path.',
  ]);
  await page.evaluate(() => {
    window.previewLease.dispose();
    document.querySelector('iframe').remove();
  });
  // A project type's page, as a phone serves it: the catalog's own checkers
  // board in a snapshot, with window.gezel relayed by its parent. WebKit too,
  // because iOS runs it.
  const port = server.httpServer.address().port;
  const typePage = [];
  for (const type of [chromium, webkit]) typePage.push(await checkTypePage(type, port));
  console.log(JSON.stringify({ ok: true, checks: 21, reads: result.reads, typePage }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}

async function checkTypePage(type, port) {
  const gilde = join(
    dirname(
      createRequire(new URL('../../catalog/package.json', import.meta.url)).resolve(
        '@bendyline/gilde/package.json',
      ),
    ),
    'data/project-types/ch/checkers/versions/1.2.0',
  );
  const board = await readFile(join(gilde, 'pages/board/index.html'), 'utf8');
  const game = await readFile(join(gilde, 'game.json'), 'utf8');
  const engine = await type.launch({ headless: true });
  try {
    const tab = await engine.newPage();
    const errors = [];
    tab.on('pageerror', (error) => errors.push(error.message));
    await tab.goto(`http://127.0.0.1:${port}/__html_test`);
    const url = await tab.evaluate(
      async ({ board, game }) => {
        const { createOfflineHtmlPreview } = await import('/src/html-preview.ts');
        const fetcher = async (input) => {
          const target = new URL(input);
          if (target.pathname === '/api/projects/game/type/bootstrap')
            return Response.json({
              apiV1: true,
              bootstrap: {
                api: 1,
                projectId: 'game',
                source: 'type',
                entry: target.searchParams.get('path'),
                typeName: 'Checkers',
                params: { personality: 'peppy', playStyle: 'Opponent' },
                tools: ['user_move', 'new_game'],
              },
            });
          if (
            target.pathname === '/api/projects/game/type/read' &&
            target.searchParams.get('path') === 'board/index.html'
          )
            return new Response(board);
          return new Response('missing', { status: 404 });
        };
        const publish = async (html) => {
          const reply = await fetch('/__publish', { method: 'POST', body: html });
          return { url: new URL((await reply.json()).url, location.href).href, dispose() {} };
        };
        const preview = createOfflineHtmlPreview(fetcher, 'token', publish);
        const lease = await preview({
          projectId: 'game',
          source: 'type',
          path: 'board/index.html',
        });
        window.bridge = [];
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        const reply = (data) => frame.contentWindow.postMessage({ __gezelPage: 1, ...data }, '*');
        // The relay HtmlPreviewFrame runs, cut down to what the board uses.
        window.addEventListener('message', (event) => {
          if (event.source !== frame.contentWindow || event.data?.__gezelPage !== 1) return;
          const message = event.data;
          window.bridge.push({ kind: message.kind, path: message.path, tool: message.tool });
          if (message.kind === 'hello')
            reply({ kind: 'init', api: 1, theme: { mode: 'light' }, limits: { maxInflight: 4 } });
          if (message.kind === 'read')
            reply({
              kind: 'read-result',
              id: message.id,
              ok: true,
              op: 'read',
              content: game,
              encoding: 'utf8',
              etag: 'e1',
            });
          if (message.kind === 'invoke')
            reply({
              kind: 'result',
              id: message.id,
              ok: true,
              output: { status: 'playing' },
              runId: 'run-1',
            });
        });
        frame.src = lease.url;
        document.body.append(frame);
        await new Promise((resolve, reject) => {
          frame.onload = resolve;
          setTimeout(() => reject(Error('Type page failed to load')), 5000);
        });
        return lease.url;
      },
      { board, game },
    );
    const frame = tab.frames().find((candidate) => candidate.url() === url);
    assert.ok(frame, 'type page snapshot loaded');
    await tab.waitForFunction(() => window.bridge.some((message) => message.kind === 'read'));
    assert.equal(await frame.evaluate(() => window.gezel.page.mode), 'embedded');
    assert.equal(
      await frame.evaluate(() =>
        [...document.querySelectorAll('[data-gezel-demo-banner]')].every(
          (element) => element.hidden || getComputedStyle(element).display === 'none',
        ),
      ),
      true,
      'a live page hides its demo banner',
    );
    const invoked = await frame.evaluate(() =>
      window.gezel.tools
        .invoke('user_move', { from: 'c3', to: 'd4' })
        .then((result) => result.runId),
    );
    assert.equal(invoked, 'run-1');
    const bridge = await tab.evaluate(() => window.bridge);
    assert.deepEqual(
      bridge.filter((message) => message.kind === 'read').map((message) => message.path),
      ['game.json'],
    );
    assert.deepEqual(errors, []);
    return { engine: type.name(), messages: [...new Set(bridge.map((message) => message.kind))] };
  } finally {
    await engine.close();
  }
}
