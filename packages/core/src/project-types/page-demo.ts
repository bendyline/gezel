import type { PageImportTarget } from '../schemas/page-imports.js';
import { pageComponentsSource } from './page-components.js';
import { PAGE_DEMO_STUB } from './page-demo-stub.js';

export interface PageDemoConfig {
  imports?: PageImportTarget[];
}

/** Shared by website publishing, local previews, and offline exports. */
export function pageDemoBootstrapSource(): string {
  return `(function(){
if(window.gezel || window.__gezelDemoBootstrap)return;
window.__gezelDemoBootstrap=1;
${PAGE_DEMO_STUB}
${pageComponentsSource()}
var make=window.makeDemoGezel;
window.makeDemoGezel=function(opts){
  if(window.gezel)return window.gezel;
  var node=document.getElementById('gezel-demo-config');
  var config=node?JSON.parse(node.textContent):{};
  var api=make(opts);
  window.installGezelComponents(api,{demoTargets:config.imports||[],existingPaths:opts&&opts.existingPaths||[]});
  return api;
};
})();`;
}

/** Only generated output changes. Never insert the demo transport into a live host. */
export function injectPageDemo(
  html: string,
  config: PageDemoConfig,
  assets: { scriptUrl: string; styleUrl: string },
): string {
  // Self-contained: the sync tool also emits this helper for Gilde's Node preview server.
  const [scriptUrl, styleUrl] = [assets.scriptUrl, assets.styleUrl].map((value) =>
    value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
  );
  if (html.includes('id="gezel-demo-config"')) throw new Error('Demo already bootstrapped.');
  // Older catalog pages embedded the adapter. Remove that exact legacy block so
  // it cannot replace the shared initializer; leave their own handlers intact.
  const source = html.replace(
    /<script\b[^>]*>\s*\/\* gezel-page-demo-stub v1 \*\/[\s\S]*?<\/script\s*>/gi,
    '',
  );
  const tags =
    `<link rel="stylesheet" data-gezel-typography href="${styleUrl}">\n` +
    `<script type="application/json" id="gezel-demo-config">${JSON.stringify(config).replace(/</g, '\\u003c')}</script>\n` +
    `<script src="${scriptUrl}"></script>\n`;
  // Keep a leading charset declaration before injected assets.
  const head = /<head\b[^>]*>\s*(?:<meta\s+charset\s*=\s*["'][^"']+["']\s*\/?>)?/i;
  if (head.test(source)) return source.replace(head, (opening) => `${opening}\n${tags}`);
  const doctype = /^\s*<!doctype[^>]*>/i;
  return doctype.test(source)
    ? source.replace(doctype, (opening) => `${opening}\n${tags}`)
    : tags + source;
}
