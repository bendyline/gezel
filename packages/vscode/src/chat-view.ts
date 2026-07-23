import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { type HostMessage, type WebviewMessage, parseWebviewMessage } from './bridge.js';
import type { Logger } from './log.js';

export type WebviewMessageHandler = (msg: WebviewMessage) => void | Promise<void>;

/**
 * Owns the VSCode webview view. Mounts the gezel chat React bundle
 * (`packages/ui/dist-embedded/chat.global.js`, copied into
 * `dist/webview/embedded/` at build time) directly into the webview,
 * with a postMessage-RPC bridge proxying every daemon call through the
 * extension host's TLS-trusting fetch. See packages/vscode/webview/
 * bridge.ts and packages/vscode/src/webview-rpc.ts.
 *
 * The host calls `post()` to push state; consumer code subscribes to
 * incoming messages via `onMessage`. The last `connection-ready` is
 * buffered and replayed on each `webview-ready` so a collapsed/hidden
 * panel re-mounts with the right state.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'gezel.chat';

  private view: vscode.WebviewView | null = null;
  private latestConnection: HostMessage | null = null;
  private readonly handlers = new Set<WebviewMessageHandler>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly logger: Logger,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'resources'),
      ],
    };
    view.webview.html = this.buildHtml(view.webview);
    view.webview.onDidReceiveMessage((raw) => {
      const msg = parseWebviewMessage(raw);
      if (!msg) {
        this.logger.warn(`webview sent malformed message: ${JSON.stringify(raw).slice(0, 200)}`);
        return;
      }
      if (msg.type === 'webview-ready' && this.latestConnection) {
        view.webview.postMessage(this.latestConnection);
      }
      for (const h of this.handlers) {
        void h(msg);
      }
    });
    view.onDidDispose(() => {
      this.view = null;
    });
  }

  onMessage(handler: WebviewMessageHandler): vscode.Disposable {
    this.handlers.add(handler);
    return new vscode.Disposable(() => this.handlers.delete(handler));
  }

  /**
   * Push a message to the webview. If the view is closed, persist
   * `connection-ready` so it replays on the next mount; other message
   * types are silently dropped (their state can be re-pushed when the
   * extension reconnects).
   */
  post(msg: HostMessage): void {
    if (msg.type === 'connection-ready' || msg.type === 'connection-error') {
      this.latestConnection = msg;
    }
    this.view?.webview.postMessage(msg);
  }

  reveal(): void {
    this.view?.show?.(true);
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = generateNonce();
    const bridgeScript = webview
      .asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'webview-bridge.global.js'),
      )
      .toString();
    const chatScript = webview
      .asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'embedded', 'chat.global.js'),
      )
      .toString();
    const chatCss = webview
      .asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'embedded', 'chat.css'),
      )
      .toString();
    const themeBridgeCss = webview
      .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'theme-bridge.css'))
      .toString();

    // CSP: nonced scripts only (no inline JS — `script-src` here also
    // covers source-map URIs); inline styles allowed for React's
    // runtime style injection (Radix uses `style=""`); fonts may be
    // self-hosted (the chat bundle ships ~15 WOFF2s under
    // `dist/webview/embedded/assets/`) or `data:` for any future
    // inlined icons. `worker-src` lets the bundle spawn module
    // workers — squisq-video-react ships a small encoder worker that
    // would otherwise be blocked by `default-src 'none'`. `blob:` is
    // included because Vite's worker bootstrap may use an inlined
    // blob URL on first load. The previous `frame-src` for the
    // loopback daemon is gone — there's no iframe anymore.
    const csp = [
      "default-src 'none'",
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `style-src 'unsafe-inline' ${webview.cspSource}`,
      `img-src ${webview.cspSource} data: https:`,
      `font-src ${webview.cspSource} data:`,
      `worker-src ${webview.cspSource} blob:`,
    ].join('; ');

    // Load order matters:
    //   1. theme-bridge.css            — maps `--vscode-*` to gezel
    //                                    CSS vars (`--bg`, `--accent`,
    //                                    …) at `:root`.
    //   2. chat.css                    — bundled gezel styles + fonts
    //                                    layered on top.
    //   3. webview-bridge.global.js    — installs `window.__GEZEL__.fetch`
    //                                    SYNCHRONOUSLY before the chat
    //                                    bundle imports api.ts (which
    //                                    reads __GEZEL__ at module init).
    //   4. chat.global.js              — React bundle. Mounts a
    //                                    placeholder, listens for
    //                                    `gezel:boot`, then renders
    //                                    EmbeddedChat with the
    //                                    project/gezel from __GEZEL__.
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Gezel</title>
  <link rel="stylesheet" href="${themeBridgeCss}" />
  <link rel="stylesheet" href="${chatCss}" />
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${bridgeScript}"></script>
  <script nonce="${nonce}" src="${chatScript}"></script>
</body>
</html>`;
  }
}

function generateNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/** Test seam — load the static webview HTML for snapshot tests. */
export function loadStaticAsset(extensionRoot: string, relativePath: string): string {
  return fs.readFileSync(path.join(extensionRoot, relativePath), 'utf8');
}
