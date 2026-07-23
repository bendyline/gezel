type HtmlInteractionSignal = 'grid' | 'click' | 'win';

interface HtmlInteractionProfile {
  inlineJsBytes: number;
  signals: Set<HtmlInteractionSignal>;
}

export function rejectRegressiveHtmlOverwrite(
  path: string,
  priorContent: string | null,
  nextContent: string,
): string | null {
  if (!isHtmlPath(path) || !priorContent) return null;

  const prior = profileHtmlInteraction(priorContent);
  const next = profileHtmlInteraction(nextContent);
  if (!isSubstantiveInteractiveHtml(prior)) return null;

  const lostSignals = [...prior.signals].filter((signal) => !next.signals.has(signal));
  const jsShrankMaterially =
    prior.inlineJsBytes >= 1000 && next.inlineJsBytes < Math.floor(prior.inlineJsBytes * 0.75);
  const nextLooksTooSmall = next.inlineJsBytes < 1000 && prior.inlineJsBytes >= 1000;

  if (lostSignals.length === 0 && !jsShrankMaterially && !nextLooksTooSmall) return null;

  return [
    `Refusing to overwrite ${path}: the existing HTML is already an interactive browser deliverable`,
    `(${prior.inlineJsBytes} bytes of inline JavaScript; signals: ${[...prior.signals].join(', ')})`,
    'but the proposed replacement is weaker',
    `(${next.inlineJsBytes} bytes of inline JavaScript; signals: ${[...next.signals].join(', ') || 'none'}).`,
    'Read the existing file and patch it with replaceInFile, or re-emit a complete version that preserves the working grid, click handling, and win/draw logic.',
  ].join(' ');
}

export function rejectHtmlWithScriptOutsideScriptTag(path: string, content: string): string | null {
  if (!isHtmlPath(path)) return null;

  const malformedContainer = rejectMalformedHtmlContainers(path, content);
  if (malformedContainer) return malformedContainer;

  const outside = stripHtmlTagMarkup(stripHtmlScriptAndStyleBlocks(content));
  if (!containsLooseJavascript(outside)) return null;
  const moduleAdvice = hasExternalModuleScript(content)
    ? 'This HTML already uses an external module script; keep the module shell clean and move loose JavaScript into the referenced .js module files instead of pasting it after </script>, </body>, or </html>.'
    : 'Put all JavaScript declarations, functions, querySelector/addEventListener calls, game state, and win/draw logic inside one complete inline <script> block before </body>.';

  return [
    `Refusing to write ${path}: it contains JavaScript-looking code outside a <script>...</script> block.`,
    moduleAdvice,
    'Do not append loose JS after </script>, </body>, or </html>; re-emit one clean complete HTML file.',
  ].join(' ');
}

export function rejectMalformedHtmlContainers(path: string, content: string): string | null {
  if (!isHtmlPath(path)) return null;

  const styleBalance = htmlRawTextTagBalance(content, 'style');
  if (styleBalance.opens !== styleBalance.closes) {
    const opening = styleBalance.firstOpenLine
      ? ` First <style> opens at line ${styleBalance.firstOpenLine}.`
      : '';
    return [
      `Refusing to write ${path}: HTML has ${styleBalance.opens} <style> opening tag(s) but ${styleBalance.closes} </style> closing tag(s).`,
      `${opening} A missing </style> makes following HTML markup parse as CSS instead of page structure.`,
      'Re-read the file and patch the smallest range that restores the complete </style>, </head>, and <body> boundary, or re-emit one clean complete HTML file.',
    ].join(' ');
  }

  const scriptBalance = htmlRawTextTagBalance(content, 'script');
  if (scriptBalance.opens < scriptBalance.closes) {
    return [
      `Refusing to write ${path}: HTML has ${scriptBalance.opens} <script> opening tag(s) but ${scriptBalance.closes} </script> closing tag(s).`,
      'Remove the extra </script> or re-emit one clean complete HTML file with balanced script blocks.',
    ].join(' ');
  }

  return null;
}

function isHtmlPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.html') || lower.endsWith('.htm');
}

function htmlRawTextTagBalance(
  html: string,
  tag: 'script' | 'style',
): { opens: number; closes: number; firstOpenLine: number | null } {
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');
  const opens = [...html.matchAll(openRe)];
  const closes = [...html.matchAll(closeRe)];
  const firstOpen = opens[0]?.index;
  return {
    opens: opens.length,
    closes: closes.length,
    firstOpenLine:
      firstOpen == null ? null : (html.slice(0, firstOpen).match(/\n/g)?.length ?? 0) + 1,
  };
}

function isSubstantiveInteractiveHtml(profile: HtmlInteractionProfile): boolean {
  return (
    profile.inlineJsBytes >= 1000 &&
    profile.signals.has('grid') &&
    profile.signals.has('click') &&
    profile.signals.has('win')
  );
}

function profileHtmlInteraction(html: string): HtmlInteractionProfile {
  const scripts = extractInlineScriptBodies(html);
  const inlineJs = scripts.join('\n');
  const combined = `${html}\n${inlineJs}`;
  const signals = new Set<HtmlInteractionSignal>();

  const cellMarkers = combined.match(
    /(?:class\s*=\s*["'][^"']*\bcell\b|<td\b|role\s*=\s*["']button["']|data-cell|cell-)/gi,
  );
  if (
    (cellMarkers?.length ?? 0) >= 9 ||
    /grid-template-columns\s*:\s*repeat\(\s*3/i.test(combined)
  ) {
    signals.add('grid');
  }
  if (/(?:addEventListener\s*\(\s*["']click["']|onclick\s*=|\.onclick\s*=)/i.test(inlineJs)) {
    signals.add('click');
  }
  if (/\b(?:winner|winning|win|draw|tie|gameOver|game-over)\b/i.test(inlineJs)) {
    signals.add('win');
  }

  return { inlineJsBytes: inlineJs.trim().length, signals };
}

function extractInlineScriptBodies(html: string): string[] {
  const out: string[] = [];
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const m of html.matchAll(scriptRe)) {
    const attrs = m[1] ?? '';
    if (/\bsrc\s*=/.test(attrs)) continue;
    out.push(m[2] ?? '');
  }
  return out;
}

function stripHtmlScriptAndStyleBlocks(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ');
}

/**
 * Keep text nodes, where loose JavaScript can actually appear, but discard tag
 * names and attributes. Attribute values such as `id="gameOver"` are ordinary
 * HTML and must not trip the JavaScript-identifier heuristics below.
 */
function stripHtmlTagMarkup(html: string): string {
  let out = '';
  let cursor = 0;

  while (cursor < html.length) {
    if (html.startsWith('<!--', cursor)) {
      const commentEnd = html.indexOf('-->', cursor + 4);
      if (commentEnd < 0) break;
      out += ' ';
      cursor = commentEnd + 3;
      continue;
    }

    if (html[cursor] !== '<' || !looksLikeHtmlTagStart(html, cursor)) {
      out += html[cursor];
      cursor += 1;
      continue;
    }

    const tagEnd = findHtmlTagEnd(html, cursor + 1);
    if (tagEnd < 0) {
      out += html.slice(cursor);
      break;
    }
    out += ' ';
    cursor = tagEnd + 1;
  }

  return out;
}

function looksLikeHtmlTagStart(html: string, offset: number): boolean {
  const next = html[offset + 1];
  if (next === '!' || next === '?') return true;
  if (next === '/') return /[A-Za-z]/.test(html[offset + 2] ?? '');
  return /[A-Za-z]/.test(next ?? '');
}

function findHtmlTagEnd(html: string, offset: number): number {
  let quote: '"' | "'" | null = null;
  for (let cursor = offset; cursor < html.length; cursor += 1) {
    const char = html[cursor];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return cursor;
  }
  return -1;
}

function hasExternalModuleScript(html: string): boolean {
  return /<script\b(?=[^>]*\btype\s*=\s*["']module["'])(?=[^>]*\bsrc\s*=)[^>]*>\s*<\/script\s*>/i.test(
    html,
  );
}

function containsLooseJavascript(text: string): boolean {
  return (
    /(?:^|[;{}\s])(?:const|let|var|function)\s+[$A-Z_a-z][$\w]*\b/.test(text) ||
    /=>/.test(text) ||
    /\b(?:querySelector(?:All)?|addEventListener|requestAnimationFrame|setInterval|setTimeout)\s*\(/.test(
      text,
    ) ||
    /\b(?:winningLines|gameOver|currentPlayer|handleClick|checkWin)\b/.test(text)
  );
}
