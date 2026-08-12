import { readFile, stat } from 'node:fs/promises';
import { type PreviewSource, resolveSecurityPolicy } from '@bendyline/gezel';
import { Hono } from 'hono';
import { realpathContained, safeJoin } from '../../fs/safe-paths.js';
import type { ServiceContext } from '../context.js';
import { mimeTypeForPath } from '../mime.js';
import type { PreviewCapabilityStore } from '../preview-capability.js';

/**
 * Live, asset-resolving preview of a project's workspace, artifacts, or
 * applied project-type page tree. The
 * Reference pane mounts an `<iframe sandbox="allow-scripts">` pointing
 * at one of these URLs and gets the full "open this index.html in a
 * browser" experience — relative `<link>`, `<script>`, and `<img>`
 * references resolve against sibling routes under the same prefix,
 * as they would on any static host.
 *
 * ──────────────────────────────────────────────────────────────────
 *  Isolation model — the HTML served here is written by an LLM and
 *  must be treated as untrusted. Three stacked defenses:
 *
 *  1. **Short-lived path capability.** An authenticated first-party caller
 *     mints a high-entropy lease bound to one source, project, and entry
 *     directory. The capability is a path segment so relative assets inherit
 *     it; no root/UI bearer appears in iframe URLs. Requests without a valid,
 *     unexpired, in-scope lease are rejected before filesystem access.
 *
 *  2. **iframe sandbox in the client.** ReferenceViewer uses
 *     `sandbox="allow-scripts"` *without* `allow-same-origin`, so the
 *     preview executes in a null origin — scripts cannot touch
 *     `window.parent`, cannot read the bearer token, cannot make
 *     same-origin requests to `/api/*` (those are bearer-gated anyway,
 *     but belt and suspenders).
 *
 *  3. **Policy-aware response headers** set here: CSP removes external
 *     resource origins unless the resolved security policy explicitly
 *     enables External services, `X-Content-Type-Options: nosniff` stops
 *     MIME-confusion tricks, and `X-Frame-Options: SAMEORIGIN` means an
 *     attacker can't load our preview from an external page and trick the
 *     user. Navigation and framing stay locked down in both modes.
 *
 *  Electron further hardens the shell (`contextIsolation: true`,
 *  `nodeIntegration: false`), so even if something escaped, there's no
 *  Node runtime in the renderer to reach. The preview route is not a
 *  path to executing arbitrary code on the user's machine.
 * ──────────────────────────────────────────────────────────────────
 *
 * A bare directory URL redirects to its trailing-slash form and then serves
 * `index.html`, preserving normal relative-asset resolution.
 */
export const PREVIEW_EXTERNAL_SERVICES_HEADER = 'x-gezel-preview-external-services';

/**
 * Build the preview document CSP from the effective renderer-network
 * permission. The permissive form admits remote resources and API/WebSocket
 * calls, but deliberately does not relax framing, form submission, base URLs,
 * plugins, or the opaque-origin iframe sandbox.
 */
export function previewContentSecurityPolicy(allowExternalNetwork: boolean): string {
  const network = allowExternalNetwork ? ' http: https:' : '';
  const sockets = allowExternalNetwork ? ' ws: wss:' : '';
  return [
    `default-src 'self'${network}`,
    `script-src 'self' 'unsafe-inline' 'unsafe-eval'${network}`,
    `style-src 'self' 'unsafe-inline'${network}`,
    `style-src-elem 'self' 'unsafe-inline'${network}`,
    `img-src 'self' data: blob:${network}`,
    `font-src 'self' data:${network}`,
    `media-src 'self' data: blob:${network}`,
    `connect-src 'self'${network}${sockets}`,
    `worker-src 'self' blob:${network}`,
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    // Chromium does not yet implement the draft CSP `webrtc` directive. Keep
    // it out of preview responses until it can be enforced instead of ignored.
    'sandbox allow-scripts',
  ].join('; ');
}

function previewSecurityHeaders(allowExternalNetwork: boolean): Record<string, string> {
  return {
    // A preview carries read authority for a source subtree. Any external
    // resource host is also a possible exfiltration endpoint, so every
    // fetchable class stays local until the user enables External services.
    'content-security-policy': previewContentSecurityPolicy(allowExternalNetwork),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'SAMEORIGIN',
    'referrer-policy': 'no-referrer',
    // Disable speculative DNS traffic in both modes. Real resource requests
    // still resolve normally when External services is enabled.
    'x-dns-prefetch-control': 'off',
    // Hardcoded for live reload — an edit to the artifact should show
    // up on the next refresh without manual cache-busting.
    'cache-control': 'no-store',
    // The sandboxed iframe has an opaque/null origin. Anonymous scripts need
    // matching CORS for useful stacks; admit that origin rather than every site.
    'access-control-allow-origin': 'null',
    // Trusted signal consumed only by the Electron shell for a second,
    // request-level enforcement layer. External pages cannot opt themselves
    // in because main accepts this header only on the daemon preview origin.
    [PREVIEW_EXTERNAL_SERVICES_HEADER]: allowExternalNetwork ? 'allowed' : 'blocked',
  };
}

function previewHeaders(mime: string, allowExternalNetwork = false): Record<string, string> {
  return { ...previewSecurityHeaders(allowExternalNetwork), 'content-type': mime };
}

async function previewAllowsExternalNetwork(ctx: ServiceContext): Promise<boolean> {
  // A malformed or temporarily unreadable config must fail closed. This read
  // happens once per HTML navigation; subresources inherit the document CSP.
  try {
    const policy = resolveSecurityPolicy(await ctx.store.readConfig());
    return policy.allowExternalServices && policy.allowAppNetwork;
  } catch {
    return false;
  }
}

/**
 * Error/log-capture shim injected at the top of every `text/html`
 * preview response. Forwards `error`, `unhandledrejection`, and
 * `console.error` calls up to the parent window via `postMessage`
 * tagged with `__gezelPreviewLog: true`. `postMessage` works across
 * null-origin sandboxed iframes, so the UI can surface runtime
 * errors without needing devtools open — critical for LLM-authored
 * prototypes where "game doesn't work" is otherwise invisible. The
 * shim is tiny, guarded by try/catch so a broken `console` or
 * `JSON.stringify` doesn't break the page, and preserves the
 * original `console.error` behavior.
 *
 * The `error` listener runs in the **capture phase** (third arg
 * `true`) so it sees subresource load failures, which don't bubble.
 * That's deliberate — a `<script>`/`<img>`/`<audio>` that 404s is
 * exactly the kind of "why is the game blank" failure we want to
 * surface. But those resource failures dispatch a plain `Event` on
 * the failing *element*, not an `ErrorEvent`, so `e.message` and
 * friends are all `undefined`. We branch on `e.target` being an
 * element to synthesize a useful "Failed to load <tag> <url>"
 * message instead of forwarding an empty payload the UI can only
 * render as "(unknown error)".
 */
export const PREVIEW_LOG_SHIM = `<script>(function(){
function clean(u){return String(u||'').replace(/(\\/preview\\/)[^/]+(\\/)/g,'$1[capability]$2');}
function send(kind,detail){try{if(detail){if(detail.message)detail.message=clean(detail.message);if(detail.filename)detail.filename=clean(detail.filename);if(detail.stack)detail.stack=clean(detail.stack);if(Array.isArray(detail.args))detail.args=detail.args.map(clean);}parent.postMessage({__gezelPreviewLog:true,kind:kind,detail:detail,url:clean(location.href),at:Date.now()},'*');}catch(_){}}
addEventListener('error',function(e){var t=e.target;if(t&&t!==window&&t.tagName){var u=t.src||t.href||'';send('error',{message:'Failed to load '+t.tagName.toLowerCase()+(u?': '+u:'')+' (resource did not load — likely 404 or blocked)'});}else{send('error',{message:e.message||(e.error&&(e.error.message||String(e.error)))||'Uncaught error (no message)',filename:e.filename,lineno:e.lineno,colno:e.colno,stack:e.error&&e.error.stack});}},true);
addEventListener('unhandledrejection',function(e){var r=e.reason;send('unhandledrejection',{message:(r&&r.message)||String(r),stack:r&&r.stack});});
var _ce=console.error;console.error=function(){try{send('console.error',{args:Array.prototype.map.call(arguments,function(a){try{return typeof a==='string'?a:JSON.stringify(a);}catch(_){return String(a);}})});}catch(_){}return _ce.apply(console,arguments);};
})();</script>`;

/**
 * Embedded-preview scrollbar treatment. The opaque-origin iframe prevents
 * the parent renderer from reaching into `contentDocument`, so the preview
 * route installs this tiny style + behavior shim alongside the log shim.
 *
 * The frame keeps its native scrollbar gutter (no content-width jump), but
 * makes the track/thumb transparent while idle. Hover, keyboard focus, or a
 * captured scroll event reveals every scroll container in the page; active
 * scrolling holds the reveal for 700ms after the final event. The root class
 * is only added when `parent !== window`, so opening the capability URL in a
 * normal browser preserves the page's ordinary scrollbar behavior.
 */
export const PREVIEW_SCROLLBAR_SHIM = `<style>
html.__gezel-preview-frame,html.__gezel-preview-frame *{scrollbar-color:transparent transparent!important}
html.__gezel-preview-frame:hover,html.__gezel-preview-frame:hover *,html.__gezel-preview-frame:focus-within,html.__gezel-preview-frame:focus-within *,html.__gezel-preview-frame.__gezel-preview-scrolling,html.__gezel-preview-frame.__gezel-preview-scrolling *{scrollbar-color:color-mix(in srgb,currentColor 48%,transparent) transparent!important}
html.__gezel-preview-frame::-webkit-scrollbar-track,html.__gezel-preview-frame *::-webkit-scrollbar-track{background:transparent!important}
html.__gezel-preview-frame::-webkit-scrollbar-thumb,html.__gezel-preview-frame *::-webkit-scrollbar-thumb{background:transparent!important}
html.__gezel-preview-frame:hover::-webkit-scrollbar-thumb,html.__gezel-preview-frame:hover *::-webkit-scrollbar-thumb,html.__gezel-preview-frame:focus-within::-webkit-scrollbar-thumb,html.__gezel-preview-frame:focus-within *::-webkit-scrollbar-thumb,html.__gezel-preview-frame.__gezel-preview-scrolling::-webkit-scrollbar-thumb,html.__gezel-preview-frame.__gezel-preview-scrolling *::-webkit-scrollbar-thumb{background:color-mix(in srgb,currentColor 48%,transparent)!important}
html.__gezel-preview-frame:hover::-webkit-scrollbar-thumb:hover,html.__gezel-preview-frame:hover *::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,currentColor 68%,transparent)!important}
html.__gezel-preview-frame::-webkit-scrollbar-button,html.__gezel-preview-frame *::-webkit-scrollbar-button{width:0!important;height:0!important}
@media(forced-colors:active){html.__gezel-preview-frame,html.__gezel-preview-frame *{scrollbar-color:auto!important}}
</style><script>(function(){
if(parent===window)return;
var root=document.documentElement,timer=0;
root.classList.add('__gezel-preview-frame');
addEventListener('scroll',function(){
root.classList.add('__gezel-preview-scrolling');
if(timer)clearTimeout(timer);
timer=setTimeout(function(){root.classList.remove('__gezel-preview-scrolling');timer=0;},700);
},true);
addEventListener('pagehide',function(){if(timer)clearTimeout(timer);},false);
})();</script>`;

/**
 * Prepare an HTML response for the sandboxed preview iframe:
 *
 *   1. Strip browser-internal stylesheet links that cannot load in an iframe.
 *   2. Inject the log-capture and embedded-scrollbar shims at the
 *      earliest viable point.
 *   3. Mark every `<script src=…>` tag `crossorigin="anonymous"`
 *      unless it already carries a `crossorigin` attribute. Combined
 *      with the narrow `Access-Control-Allow-Origin: null` header the preview
 *      route sets on all responses, this unlocks real error detail
 *      (filename, lineno, stack) in the shim's `error` listener.
 *      Without this pair, the null-origin iframe sees every runtime
 *      error as the useless `"Script error."`.
 */
const BROWSER_INTERNAL_LINK_RE =
  /<link\b(?=[^>]*\bhref\s*=\s*(?:"chrome:\/\/[^"\r\n]*"|'chrome:\/\/[^'\r\n]*'|chrome:\/\/[^\s>]+))[^>]*>/gi;
const SCRIPT_ELEMENT_RE = /<script\b([^>]*)>[\s\S]*?<\/script\s*>/gi;

function htmlAttribute(attrs: string, name: string): string | null {
  const match = attrs.match(
    new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function unbuiltSourceModuleShim(sources: string[]): string {
  if (sources.length === 0) return '';
  const names = sources.join(', ');
  const message = `Preview cannot run unbuilt TypeScript/JSX module${sources.length > 1 ? 's' : ''}: ${names}. Build the app and preview its generated dist/index.html, or run its development server.`;
  // The preview owns its color palette, so derive a quiet translucent alert
  // from its current text color instead of forcing a bright light-theme card.
  return `<script>(function(){
var message=${JSON.stringify(message)};
console.error(message);
addEventListener('DOMContentLoaded',function(){
var box=document.createElement('div');
box.setAttribute('role','alert');
box.style.cssText='box-sizing:border-box;width:calc(100% - clamp(48px,12vw,96px));max-width:720px;margin:clamp(40px,8vh,64px) auto;padding:clamp(28px,5vw,36px);border:1px solid color-mix(in srgb,currentColor 24%,transparent);border-radius:10px;background:color-mix(in srgb,currentColor 7%,transparent);color:inherit;font:16px/1.6 system-ui,sans-serif;white-space:pre-wrap';
box.textContent=message;
if(document.body)document.body.replaceChildren(box);
},{once:true});
})();</script>`;
}

/**
 * Prepare standalone HTML for the preview sandbox.
 *
 * Chromium's generated `LICENSES.chromium.html` is authored for the privileged
 * `chrome://credits` page and links to internal `chrome://` stylesheets. Those
 * resources can never load from an ordinary HTTPS document; leaving the tags
 * in place produces renderer errors and feeds false failures into the preview
 * log. Strip only browser-internal `<link>` resources while preserving normal
 * relative/HTTPS links and literal `chrome://` text in the document body.
 */
export function preparePreviewHtml(html: string): string {
  let out = html.replace(BROWSER_INTERNAL_LINK_RE, '');
  const unbuiltSourceModules: string[] = [];
  out = out.replace(SCRIPT_ELEMENT_RE, (match, rawAttrs: string) => {
    const type = htmlAttribute(rawAttrs, 'type');
    const src = htmlAttribute(rawAttrs, 'src');
    if (
      type?.toLowerCase() !== 'module' ||
      !src ||
      !/\.(?:[cm]?ts|tsx|jsx)(?:[?#].*)?$/i.test(src)
    ) {
      return match;
    }
    unbuiltSourceModules.push(src);
    return `<!-- Gezel omitted unbuilt source module: ${src.replaceAll('--', '—')} -->`;
  });
  const headMatch = out.match(/<head[^>]*>/i);
  const shims =
    PREVIEW_LOG_SHIM + PREVIEW_SCROLLBAR_SHIM + unbuiltSourceModuleShim(unbuiltSourceModules);
  if (headMatch) {
    const at = (headMatch.index ?? 0) + headMatch[0].length;
    out = out.slice(0, at) + shims + out.slice(at);
  } else {
    out = shims + out;
  }
  out = out.replace(/<script\b([^>]*)>/gi, (match, rawAttrs: string) => {
    // Only touch external scripts — inline `<script>` blocks don't
    // have a src and don't hit the cross-origin scrubbing rules.
    if (!/\bsrc\s*=/.test(rawAttrs)) return match;
    if (/\bcrossorigin\b/.test(rawAttrs)) return match;
    const src = htmlAttribute(rawAttrs, 'src');
    // Classic cross-origin scripts are allowed to load without CORS. Do not
    // force anonymous CORS onto them in External services mode, because that
    // would reject otherwise-valid third-party dependencies whose servers do
    // not emit Access-Control-Allow-Origin. Module scripts still apply their
    // browser-mandated CORS rules.
    if (src && /^(?:https?:)?\/\//i.test(src)) return match;
    return `<script${rawAttrs} crossorigin="anonymous">`;
  });
  return out;
}

/**
 * Serves raw files from one of a project's two file trees with the
 * hardened CSP + sandbox headers above. The `source` path segment
 * picks the tree: `artifacts` (the curated drawer under the project)
 * or `workspace` (the project's external `workingDir` or internal
 * fallback). Keeping both capability and `source` in the path — rather than
 * a query param — is load-bearing: when a served HTML file references
 * `style.css` with a relative URL, the browser resolves it against
 * the path alone (query strings aren't inherited), so the
 * subresource request must also carry the source segment. A
 * query-param shape would route every relative asset back to
 * `artifacts` and 404.
 */
export function previewRoutes(ctx: ServiceContext, capabilities: PreviewCapabilityStore): Hono {
  const app = new Hono();

  app.get('/:capability/:source/:projectId/*', async (c) => {
    const capability = c.req.param('capability');
    const source = c.req.param('source');
    if (source !== 'artifacts' && source !== 'workspace' && source !== 'type') {
      return c.json({ error: 'preview capability required' }, 401);
    }
    const projectId = c.req.param('projectId');
    const fullPath = c.req.path;
    const prefix = `/preview/${capability}/${source}/${projectId}/`;
    let filePath = fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : '';
    try {
      filePath = decodeURIComponent(filePath);
    } catch {
      return c.json({ error: 'bad path' }, 400);
    }
    const requestedDirectoryUrl = filePath === '' || filePath.endsWith('/');
    const authorized = capabilities.authorize({
      token: capability,
      source: source as PreviewSource,
      projectId,
      path: filePath,
    });
    if (!authorized.ok) {
      if (authorized.reason === 'expired') {
        return c.json({ error: 'preview capability expired' }, 410);
      }
      if (authorized.reason === 'scope') {
        return c.json({ error: 'preview capability is out of scope' }, 403);
      }
      return c.json({ error: 'invalid preview capability' }, 401);
    }
    filePath = authorized.path;
    if (requestedDirectoryUrl) {
      filePath = `${filePath}index.html`;
    }

    // `type` source: the read-only page tree ships with the project's applied
    // custom project type, so it lives in the catalog (bundled/local), not on
    // the project's filesystem. Resolve the provenance and read from the
    // catalog's `pages/` folder. See docs/project-types.md.
    if (source === 'type') {
      const project = await ctx.store.getProject(projectId).catch(() => null);
      const pt = project?.projectType;
      if (!pt) return c.json({ error: 'project has no applied project type' }, 404);
      // `catalog.readItemFile` rejects `..` / absolute paths, so a page can't
      // escape the `pages/` subtree.
      const buf = await ctx.catalog
        .readItemFile('project-type', pt.id, `pages/${filePath}`, pt.source, pt.version)
        .catch(() => null);
      if (!buf) return c.json({ error: 'not found' }, 404);
      const mime = mimeTypeForPath(filePath);
      if (mime.startsWith('text/html')) {
        const allowExternalNetwork = await previewAllowsExternalNetwork(ctx);
        return c.body(
          preparePreviewHtml(buf.toString('utf8')),
          200,
          previewHeaders(mime, allowExternalNetwork),
        );
      }
      return c.body(new Uint8Array(buf), 200, previewHeaders(mime));
    }

    const baseDir =
      source === 'workspace'
        ? await ctx.store.projectWorkspaceDir(projectId)
        : ctx.store.projectArtifactsDir(projectId);
    const full = safeJoin(baseDir, filePath);
    if (!full || !(await realpathContained(baseDir, full))) {
      return c.json({ error: 'path traversal blocked' }, 400);
    }

    try {
      const s = await stat(full);
      if (s.isDirectory()) {
        // Static-host semantics require a directory URL to end in `/`; without
        // it, `style.css` resolves beside the directory instead of inside it.
        return c.redirect(`${c.req.path}/`, 308);
      }
      const mime = mimeTypeForPath(filePath);
      if (mime.startsWith('text/html')) {
        const html = preparePreviewHtml((await readFile(full)).toString('utf8'));
        const allowExternalNetwork = await previewAllowsExternalNetwork(ctx);
        return c.body(html, 200, previewHeaders(mime, allowExternalNetwork));
      }
      const buf = await readFile(full);
      return c.body(new Uint8Array(buf), 200, previewHeaders(mime));
    } catch {
      return c.json({ error: 'not found' }, 404);
    }
  });

  return app;
}
