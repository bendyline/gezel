import { type HtmlElementPart, type ModuleImport, locateScriptsAndLinks } from './html-rewrite.js';
import { parseCdnUrl } from './resolver.js';

/**
 * `<script type="text/babel">` compiled where the page is served, as Babel's
 * 6.7 MB in-browser compiler would have compiled it on load. The usual React
 * page a model writes loads React and Babel from a CDN and puts its JSX in
 * such a script; with the compile done here, the Babel tag is dropped and
 * the page needs only React from the shelf.
 */

const JSX_TYPES = new Set(['text/babel', 'text/jsx', 'text/tsx']);

export interface InlineJsxCompiled {
  code: string;
  imports: ModuleImport[];
  errors: string[];
}

function attribute(part: HtmlElementPart, name: string) {
  return part.attributes.find((entry) => entry.name === name);
}

function isJsxScript(part: HtmlElementPart): boolean {
  if (part.tag !== 'script') return false;
  return JSX_TYPES.has(attribute(part, 'type')?.value.trim().toLowerCase() ?? '');
}

/**
 * A script whose body is JSX for an in-browser compiler. One with a `src`
 * is not inline: its empty body was compiled into an empty module and the
 * Babel tag removed, so `<script type="text/babel" src="app.jsx">` pages
 * rendered blank (1.26326.112 release audit). Those are left for Babel.
 */
export function isInlineJsxScript(part: HtmlElementPart): boolean {
  return isJsxScript(part) && !attribute(part, 'src');
}

/** Babel's in-browser compiler, by any CDN spelling. */
export function isBabelStandaloneUrl(url: string): boolean {
  const request = parseCdnUrl(url);
  return request?.package === '@babel/standalone' || request?.cdnjs === 'babel-standalone';
}

function problemScript(message: string): string {
  return `<script>console.error(${JSON.stringify(message).replace(/</g, '\\u003c')});</script>`;
}

/**
 * The page with each JSX script compiled into a module script, and the
 * Babel tag gone when there was anything to compile. A script that does not
 * compile becomes one that reports why in the console, where the page check
 * and the preview log read it.
 */
export function compileInlineJsx(
  html: string,
  compile: (code: string, path: string) => InlineJsxCompiled,
  parts: readonly HtmlElementPart[] = locateScriptsAndLinks(html),
): string {
  const scripts = parts.filter((part) => isInlineJsxScript(part) && part.bodyStart !== undefined);
  if (!scripts.length) return html;
  let out = html;
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const [index, part] of scripts.entries()) {
    const presets = attribute(part, 'data-presets')?.value ?? '';
    const typescript =
      /typescript/i.test(presets) ||
      attribute(part, 'type')?.value.trim().toLowerCase() === 'text/tsx';
    const path = `inline-${index + 1}.${typescript ? 'tsx' : 'jsx'}`;
    const compiled = compile(html.slice(part.bodyStart, part.bodyEnd), path);
    const text = compiled.errors.length
      ? problemScript(`This page's JSX did not compile: ${compiled.errors[0]}`)
      : `<script type="module">${compiled.code.replace(/<\/(script)/gi, '<\\/$1')}</script>`;
    edits.push({ start: part.start, end: part.end, text });
  }
  // Babel stays while a JSX script it would fetch and compile itself remains.
  const babelStillNeeded = parts.some((part) => isJsxScript(part) && attribute(part, 'src'));
  for (const part of babelStillNeeded ? [] : parts) {
    const src = attribute(part, 'src')?.value;
    if (part.tag === 'script' && src && isBabelStandaloneUrl(src)) {
      edits.push({ start: part.start, end: part.end, text: '' });
    }
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}
