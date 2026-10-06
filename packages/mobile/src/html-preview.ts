import {
  type PreviewModule,
  bundlePreviewModules,
  isPreviewCompiledPath,
  isPreviewModulePath,
  pageApiShimSource,
  previewImportProblem,
  resolvePreviewImport,
} from '@bendyline/gezel';
import { previewAssetPath, previewEntryPath } from './html-preview-path.js';
import type { PreviewModuleCompiler } from './script-compiler.js';

import type { PageApiBootstrap } from '@bendyline/gezel';
import type { HostHtmlPreview, HostHtmlPreviewRequest } from '../../ui/src/html-preview-host.js';
type OfflineHtmlPreviewRequest = HostHtmlPreviewRequest;
type OfflineHtmlPreview = HostHtmlPreview;
export type PublishHtmlPreview = (html: string) => Promise<OfflineHtmlPreview>;
const MAX_FILE = 2 * 1024 * 1024;
const MAX_TOTAL = 16 * 1024 * 1024;
const MAX_FILES = 64;
export const OFFLINE_PREVIEW_CSP =
  "default-src 'none'; script-src data:; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  vtt: 'text/vtt',
};
/** The host reads authenticated product bytes. The page gets only bounded copies
 * of the chosen entry's relative assets, no product token or native bridge. */
export function createOfflineHtmlPreview(
  fetcher: typeof fetch,
  token: string,
  publish: PublishHtmlPreview,
  compileModules?: () => PreviewModuleCompiler,
) {
  return async (request: OfflineHtmlPreviewRequest): Promise<OfflineHtmlPreview> => {
    const entry = previewEntryPath(request.path);
    if (!/\.html?$/i.test(entry)) throw new Error('Choose an HTML file to preview');
    const project = `https://gezel.local/api/projects/${encodeURIComponent(request.projectId)}`;
    const headers = { Authorization: `Bearer ${token}` };
    let prelude: string | undefined;
    if (request.source === 'type') {
      // A project type's page reads its project through the parent, so it
      // carries the same window.gezel the desktop serves it with.
      const response = await fetcher(
        `${project}/type/bootstrap?path=${encodeURIComponent(entry)}`,
        { headers },
      );
      const body = (await response.json().catch(() => ({}))) as {
        bootstrap?: PageApiBootstrap;
        apiV1?: boolean;
        error?: string;
      };
      if (!response.ok || !body.bootstrap)
        throw new Error(body.error ?? `Could not open this page (${response.status})`);
      if (!body.apiV1)
        throw new Error(
          'This page has not been updated to run on a phone yet. Its project still works in chat.',
        );
      prelude = pageApiShimSource(body.bootstrap);
    }
    const area = request.source === 'type' ? 'type' : request.source;
    return buildOfflineHtmlPreview(
      entry,
      async (path) => {
        const response = await fetcher(
          `${project}/${area}/read?raw=1&path=${encodeURIComponent(path)}`,
          { headers },
        );
        if (!response.ok)
          throw new Error(`Could not read preview file ${path} (${response.status})`);
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Preview file is empty');
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          size += result.value.length;
          if (size > MAX_FILE) {
            await reader.cancel();
            throw new Error('A preview file exceeds 2 MiB');
          }
          chunks.push(result.value);
        }
        const data = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          data.set(chunk, offset);
          offset += chunk.length;
        }
        return data;
      },
      publish,
      compileModules,
      prelude,
    );
  };
}

export async function buildOfflineHtmlPreview(
  entryPath: string,
  read: (path: string) => Promise<Uint8Array>,
  publish: PublishHtmlPreview,
  /** Compiles TypeScript and module scripts; without it a page must use classic scripts. */
  compileModules?: () => PreviewModuleCompiler,
  /** Host script that runs after the log shim and before any page script. */
  prelude?: string,
): Promise<OfflineHtmlPreview> {
  const entry = previewEntryPath(entryPath);
  const bytes = new Map<string, Uint8Array>();
  const assets = new Map<string, string>();
  let total = 0;
  let embedded = 0;
  const account = (value: string) => {
    embedded += new TextEncoder().encode(value).byteLength;
    if (embedded > 8 * 1024 * 1024)
      throw new Error('This preview exceeds 8 MiB after embedding its assets');
    return value;
  };
  const dataUrl = (content: string | Uint8Array, mime: string) => {
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    let binary = '';
    for (let offset = 0; offset < data.length; offset += 8192)
      binary += String.fromCharCode(...data.subarray(offset, offset + 8192));
    return `data:${mime};base64,${btoa(binary)}`;
  };
  const keep = (path: string, data: Uint8Array) => {
    if (data.byteLength > MAX_FILE) throw new Error('A preview file exceeds 2 MiB');
    total += data.byteLength;
    if (total > MAX_TOTAL) throw new Error('This preview exceeds 16 MiB');
    bytes.set(path, data);
    return data;
  };
  const load = async (path: string) => {
    const existing = bytes.get(path);
    if (existing) return existing;
    if (bytes.size >= MAX_FILES) throw new Error('This preview needs more than 64 files');
    return keep(path, await read(path));
  };
  const text = async (path: string) =>
    new TextDecoder('utf-8', { fatal: true }).decode(await load(path));
  const asset = async (reference: string, relativeTo: string) => {
    if (reference.startsWith('data:')) return account(reference);
    const path = previewAssetPath(reference, relativeTo, entry);
    const old = assets.get(path);
    if (old) return account(old);
    const mime = TYPES[path.split('.').at(-1)?.toLowerCase() ?? ''];
    if (!mime) throw new Error(`Unsupported preview asset: ${path}`);
    const url = dataUrl(await load(path), mime);
    assets.set(path, url);
    return account(url);
  };
  const css = async (
    original: string,
    relativeTo: string,
    ancestors: string[] = [],
  ): Promise<string> => {
    let input = original;
    if (ancestors.length > 12) throw new Error('Stylesheet nesting exceeds the preview limit');
    let result = '';
    let last = 0;
    const imports = /@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?\s*;/gi;
    for (const match of input.matchAll(imports)) {
      result += input.slice(last, match.index);
      const path = previewAssetPath(match[1]!, relativeTo, entry);
      if (ancestors.includes(path)) throw new Error('Stylesheet import cycle');
      const imported = await css(await text(path), path, [...ancestors, path]);
      if (result.length + imported.length > 8 * 1024 * 1024)
        throw new Error('Expanded stylesheet exceeds 8 MiB');
      result += imported;
      last = match.index + match[0].length;
    }
    result += input.slice(last);
    input = result;
    result = '';
    last = 0;
    const references = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)/gi;
    for (const match of input.matchAll(references)) {
      const reference = match[1] ?? match[2] ?? match[3] ?? '';
      result += input.slice(last, match.index);
      result += reference.startsWith('#')
        ? match[0]
        : `url("${await asset(reference, relativeTo)}")`;
      if (result.length > 8 * 1024 * 1024) throw new Error('Expanded stylesheet exceeds 8 MiB');
      last = match.index + match[0].length;
    }
    return result + input.slice(last);
  };
  const scope = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/') + 1) : '';
  /** The first candidate the project has, inside the previewed folder. */
  const firstExisting = async (candidates: string[]) => {
    for (const candidate of candidates) {
      if (!candidate.startsWith(scope)) continue;
      if (bytes.has(candidate)) return candidate;
      try {
        previewEntryPath(candidate);
      } catch {
        continue;
      }
      if (bytes.size >= MAX_FILES) throw new Error('This preview needs more than 64 files');
      let data: Uint8Array;
      try {
        data = await read(candidate);
      } catch (error) {
        if (error instanceof Error && error.message.includes('exceeds')) throw error;
        continue;
      }
      keep(candidate, data);
      return candidate;
    }
    return undefined;
  };
  /** An imported file that is not code: JSON, a stylesheet, or an asset's URL. */
  const dataModule = async (path: string): Promise<string> => {
    if (/\.json$/i.test(path)) {
      const source = await text(path);
      try {
        JSON.parse(source);
      } catch {
        throw new Error(`${path} is not valid JSON`);
      }
      return `module.exports=${source};`;
    }
    if (/\.css$/i.test(path))
      return `var style=document.createElement('style');style.textContent=${JSON.stringify(await css(await text(path), path, [path]))};document.head.appendChild(style);`;
    const mime = TYPES[path.split('.').at(-1)?.toLowerCase() ?? ''];
    if (!mime) throw new Error(`${path} cannot be imported by a preview`);
    let url = assets.get(path);
    if (!url) {
      url = dataUrl(await load(path), mime);
      assets.set(path, url);
    }
    return `module.exports=${JSON.stringify(account(url))};`;
  };
  /**
   * Compiles the module scripts' import graph a round at a time and links it
   * into one classic script. A snapshot's scripts are data URLs, which have
   * nothing to resolve a relative import against, so the files cannot be
   * left to import each other.
   */
  const linkModules = async (entries: string[]) => {
    const compiler = compileModules!();
    try {
      const modules = new Map<string, PreviewModule>();
      const seen = new Set(entries);
      let round = [...seen];
      while (round.length) {
        const sources: { path: string; source: string }[] = [];
        for (const path of round) {
          const inline = inlineModules.get(path);
          if (inline !== undefined) sources.push({ path, source: inline });
          else if (isPreviewModulePath(path)) sources.push({ path, source: await text(path) });
          else modules.set(path, { path, code: await dataModule(path), requires: {} });
        }
        round = [];
        for (const compiled of sources.length ? await compiler.compile(sources) : []) {
          if (compiled.errors.length) throw new Error(compiled.errors.slice(0, 3).join('\n'));
          const requires: Record<string, string> = {};
          for (const { specifier } of compiled.imports) {
            const found = resolvePreviewImport(specifier, compiled.path);
            const target =
              found.kind === 'file' ? await firstExisting(found.candidates) : undefined;
            if (!target) throw new Error(previewImportProblem(compiled.path, specifier, found));
            requires[specifier] = target;
            if (!seen.has(target)) {
              seen.add(target);
              round.push(target);
            }
          }
          modules.set(compiled.path, { path: compiled.path, code: compiled.code, requires });
        }
      }
      return bundlePreviewModules([...modules.values()], entries);
    } finally {
      compiler.dispose();
    }
  };
  // Template contents stay inert while assets and CSP are prepared. Nothing
  // from the file is attached to the privileged app document.
  const template = document.createElement('template');
  template.innerHTML = await text(entry);
  for (const node of template.content.querySelectorAll(
    'base,iframe,frame,frameset,object,embed,applet,portal,meta[http-equiv]',
  ))
    node.remove();
  const handlers: string[] = [];
  const moduleScripts: { element: Element; path: string }[] = [];
  const inlineModules = new Map<string, string>();
  for (const element of template.content.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on')) {
        const key = `event-${handlers.length}`;
        element.setAttribute(`data-gezel-${key}`, '');
        element.removeAttribute(attribute.name);
        if (!/^on[a-z]+$/.test(name)) continue;
        handlers.push(
          `document.querySelector('[data-gezel-${key}]').addEventListener(${JSON.stringify(name.slice(2))},function(event){if((function(event){\n${attribute.value}\n}).call(this,event)===false){event.preventDefault();}});`,
        );
      }
      if (
        ['srcset', 'ping', 'formaction', 'action', 'nonce', 'integrity', 'crossorigin'].includes(
          name,
        )
      )
        element.removeAttribute(attribute.name);
    }
    const tag = element.tagName.toLowerCase();
    if (tag === 'script') {
      const type = element.getAttribute('type')?.toLowerCase() ?? '';
      const src = element.getAttribute('src');
      // A `.ts` file can only be a module, whatever its tag says.
      if (type === 'module' || (src && isPreviewCompiledPath(src.split(/[?#]/, 1)[0]!))) {
        if (!compileModules)
          throw new Error('This preview needs a built standalone page using classic JavaScript');
        const path = src
          ? previewAssetPath(src, entry, entry)
          : `${entry} (module ${moduleScripts.length + 1})`;
        if (!src) inlineModules.set(path, element.textContent ?? '');
        moduleScripts.push({ element, path });
        continue;
      }
      if (type && !['text/javascript', 'application/javascript'].includes(type)) continue;
      const code = src
        ? await text(previewAssetPath(src, entry, entry))
        : (element.textContent ?? '');
      element.textContent = '';
      element.setAttribute('src', account(dataUrl(code, 'text/javascript')));
      continue;
    }
    if (tag === 'link') {
      if (element.getAttribute('rel')?.toLowerCase() === 'stylesheet') {
        const path = previewAssetPath(element.getAttribute('href') ?? '', entry, entry);
        const style = document.createElement('style');
        style.textContent = await css(await text(path), path, [path]);
        const media = element.getAttribute('media');
        if (media) style.setAttribute('media', media);
        element.replaceWith(style);
      } else element.remove();
      continue;
    }
    if (tag === 'style') element.textContent = await css(element.textContent ?? '', entry);
    if (element.hasAttribute('style'))
      element.setAttribute('style', await css(element.getAttribute('style')!, entry));
    for (const name of ['src', 'href', 'xlink:href', 'poster', 'background']) {
      const value = element.getAttribute(name);
      if (!value) continue;
      if (value.startsWith('#')) continue;
      if (tag === 'a' || tag === 'area') {
        element.removeAttribute(name);
        continue;
      }
      element.setAttribute(name, await asset(value, entry));
    }
  }
  if (moduleScripts.length) {
    const linked = await linkModules(moduleScripts.map(({ path }) => path));
    const [first, ...rest] = moduleScripts;
    for (const { name } of [...first!.element.attributes]) first!.element.removeAttribute(name);
    first!.element.textContent = '';
    // Module scripts run once the document is parsed; a deferred classic
    // script runs then too, so a game that looks up its canvas still finds it.
    first!.element.setAttribute('src', account(dataUrl(linked, 'text/javascript')));
    first!.element.setAttribute('defer', '');
    for (const { element } of rest) element.remove();
  }
  const log = dataUrl(
    `(()=>{
// CSP does not govern WebRTC. Close it before authored code, along with new
// object-URL documents that could otherwise acquire an uninitialized realm.
for(const name of Object.getOwnPropertyNames(window)){if(name.startsWith('RTC')||name==='webkitRTCPeerConnection'){try{Object.defineProperty(window,name,{value:undefined,writable:false,configurable:false});}catch{}}}
for(const value of [window.URL,window.webkitURL]){if(value)try{Object.defineProperty(value,'createObjectURL',{value:undefined,writable:false,configurable:false});}catch{}}
const send=(kind,detail)=>parent.postMessage({__gezelPreviewLog:true,kind,detail,url:${JSON.stringify(entry)},at:Date.now()},'*');addEventListener('error',e=>send('error',{message:e.message||'A preview resource could not load'}),true);addEventListener('unhandledrejection',e=>send('unhandledrejection',{message:String(e.reason)}));const original=console.error;console.error=(...args)=>{send('console.error',{args:args.map(String)});original(...args);};})();`,
    'text/javascript',
  );
  const events = handlers.length
    ? `<script src="${dataUrl(handlers.join('\n'), 'text/javascript')}"></script>`
    : '';
  const hostScript = prelude
    ? `<script src="${account(dataUrl(prelude, 'text/javascript'))}"></script>`
    : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${OFFLINE_PREVIEW_CSP}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><script src="${log}"></script>${hostScript}</head><body>${template.innerHTML}${events}</body></html>`;
  if (new TextEncoder().encode(html).byteLength > 8 * 1024 * 1024)
    throw new Error('This preview exceeds 8 MiB after embedding its assets');
  return await publish(html);
}
