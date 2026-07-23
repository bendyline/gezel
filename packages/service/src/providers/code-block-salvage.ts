/**
 * Code-block salvage for the "stuck planning, code-in-chat" failure mode.
 *
 * Gemma-family local models (Gemma 4 26B in particular on the native MLX
 * path) sometimes respond to a coding task by writing the file contents
 * directly in the assistant turn as a fenced markdown block — instead
 * of calling `writeFile` / `write_artifact`. The ramble detector
 * catches the resulting 20K-char dump and aborts, but the throw kills
 * the turn outright; the carefully-written code is discarded.
 *
 * This helper scans an aborted-ramble buffer for fenced code blocks
 * and converts each into a `write_artifact` call. The synthesized
 * tool calls flow through the same `repairedCalls` path as our other
 * salvage layers, so the bridge executes them and the next loop
 * iteration sees real file results. Net effect: the eval HTML gets
 * written and the trial completes instead of timing out.
 *
 * Heuristics keep this conservative — we only salvage when the block
 * has a recognizable language fence AND a filename can be derived
 * (from an immediately-preceding hint like "**index.html:**" or a
 * language-default like `html → index.html`), OR when an untyped fence
 * contains a plain-text `writeFile({ path, content })` call.
 */

export interface SalvagedCodeBlock {
  /** Filename derived from a preceding hint or the language fence. */
  filename: string;
  /** Language tag from the fence (e.g. `html`, `javascript`, `css`). */
  lang: string;
  /** Block content stripped of fence markers. */
  content: string;
}

/**
 * Language-to-default-filename map for fences without an explicit hint.
 * Only covers the small set the tic-tac-toe / petshop / web-task
 * scenarios produce. Anything outside this list returns `null` from
 * `defaultFilenameForLang` and the block is skipped — better to skip
 * than to write a wrong-named artifact.
 */
const LANG_TO_DEFAULT_FILENAME: Record<string, string> = {
  html: 'index.html',
  htm: 'index.html',
  javascript: 'script.js',
  js: 'script.js',
  typescript: 'script.ts',
  ts: 'script.ts',
  css: 'style.css',
  json: 'data.json',
  python: 'main.py',
  py: 'main.py',
};

const EXTENSION_TO_LANG: Record<string, string> = {
  html: 'html',
  htm: 'html',
  js: 'javascript',
  mjs: 'javascript',
  ts: 'typescript',
  css: 'css',
  json: 'json',
  py: 'python',
  md: 'markdown',
  txt: 'text',
  svg: 'svg',
};

function defaultFilenameForLang(lang: string): string | null {
  const key = lang.toLowerCase();
  return LANG_TO_DEFAULT_FILENAME[key] ?? null;
}

function langForFilename(filename: string): string | null {
  const m = filename.match(/\.([a-zA-Z0-9]+)$/);
  if (!m) return null;
  return EXTENSION_TO_LANG[m[1]!.toLowerCase()] ?? null;
}

function filenameMatchesLang(filename: string, lang: string): boolean {
  const filenameLang = langForFilename(filename);
  if (!filenameLang) return false;
  return normalizeLang(filenameLang) === normalizeLang(lang);
}

function normalizeLang(lang: string): string {
  const key = lang.toLowerCase();
  if (key === 'js' || key === 'mjs') return 'javascript';
  if (key === 'ts') return 'typescript';
  if (key === 'htm') return 'html';
  if (key === 'py') return 'python';
  return key;
}

/**
 * Look at the up-to-200-char window immediately preceding a fence
 * opener for a filename hint. Patterns we recognize:
 *   - `**index.html**` / `**index.html:**`
 *   - `# index.html`
 *   - `filename: index.html`
 *   - `// index.html` (inline comment)
 *   - bare `index.html` on a line by itself
 *
 * Returns the matched filename (with extension) or null when nothing
 * obvious is found.
 */
function deriveFilenameFromHint(window: string): string | null {
  // Restrict to filenames with sensible extensions to avoid catching
  // random prose tokens that happen to end in `.io` / `.me` / etc.
  const filenamePattern = /\b([a-zA-Z0-9_-]+\.(?:html?|js|ts|css|json|md|txt|py|svg))\b/;
  // Walk the window from the end back so the nearest filename wins.
  const lines = window.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(filenamePattern);
    if (m) return m[1]!;
  }
  return null;
}

/**
 * Extract every fenced code block from `text` and pair it with a
 * salvageable filename. Returns an empty array when no fence matches
 * or no filename could be derived for any candidate.
 *
 * The fence regex is intentionally permissive on the closing marker
 * (allows trailing whitespace, accepts unterminated blocks at end of
 * buffer) because ramble-aborted streams often cut off mid-block.
 * Unterminated blocks are still emitted — better to write a slightly-
 * truncated HTML than to throw the whole turn away.
 */
export function salvageCodeBlocks(text: string): SalvagedCodeBlock[] {
  // Match opener: ```<lang> or ~~~<lang>. Capture lang group.
  // Then capture everything up to closing ``` / ~~~ on its own line
  // OR end-of-string (unterminated block).
  const fenceRe = /(?:^|\n)([`~]{3,})([a-zA-Z0-9_+-]+)?[ \t]*\n([\s\S]*?)(?:\n\1[ \t]*(?=\n|$)|$)/g;
  const blocks: SalvagedCodeBlock[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null = fenceRe.exec(text);
  while (m !== null) {
    const lang = (m[2] ?? '').trim();
    const content = (m[3] ?? '').trim();
    if (!lang && content.length > 0) {
      const writeFileBlock = salvageWriteFileFence(content);
      if (writeFileBlock) {
        blocks.push(writeFileBlock);
      } else {
        const fenceStart = m.index;
        const hintWindow = text.slice(Math.max(0, fenceStart - 200), fenceStart);
        const hintFilename = deriveFilenameFromHint(hintWindow);
        const hintLang = hintFilename ? langForFilename(hintFilename) : null;
        if (hintFilename && hintLang && contentLooksLikeLang(content, hintLang)) {
          blocks.push({ filename: hintFilename, lang: hintLang, content });
        }
      }
    } else if (lang && content.length > 0) {
      // Window of up to 200 chars immediately before the fence — gives
      // the filename-hint heuristic context to work with.
      const fenceStart = m.index;
      const hintWindow = text.slice(Math.max(0, fenceStart - 200), fenceStart);
      const hintFilename = deriveFilenameFromHint(hintWindow);
      const defaultName = defaultFilenameForLang(lang);
      const filename =
        hintFilename && filenameMatchesLang(hintFilename, lang) ? hintFilename : defaultName;
      if (filename) {
        blocks.push({ filename, lang, content });
      }
    }
    lastIdx = m.index + m[0].length;
    m = fenceRe.exec(text);
  }
  void lastIdx;
  // Overwriting a `.html` target needs a COMPLETE document. A bare
  // fragment — a `<script>` body, a JS snippet, a partial markup chunk —
  // is rejected by the source-write-guard ("Refusing to replace … with a
  // JavaScript fragment"), so promoting it to a synthesized `writeFile`
  // only burns the failure-tracker budget on a guaranteed rejection.
  // Drop those; keep complete documents (and all non-HTML targets).
  // Wild-caught (qwen3.6 a3b): salvaged `<script>`-only blocks
  // failed `writeFile(index.html)` twice, helping abort the turn at 5.
  return blocks.filter(
    (b) => !/\.html?$/i.test(b.filename) || /<!doctype html|<html[\s>]/i.test(b.content),
  );
}

/**
 * Turn a rambling response into a bounded write batch. Raw extraction is
 * intentionally permissive, but executing every fence is unsafe: verbose
 * models often emit a sequence of alternative snippets that all default to
 * `script.js`, turning one bad response into many destructive overwrites.
 *
 * When the active step names a deliverable, salvage only the best complete
 * candidate for that exact path. Otherwise coalesce duplicate paths to one
 * strongest candidate and refuse ambiguous repeated JS/TS fragments that do
 * not look like standalone source files.
 */
export function prepareSalvagedCodeBlocks(
  text: string,
  preferredPath?: string,
): SalvagedCodeBlock[] {
  const extracted = salvageCodeBlocks(text);
  if (preferredPath) {
    const normalizedPreferred = normalizeSalvagePath(preferredPath);
    const candidates = extracted.filter(
      (block) => normalizeSalvagePath(block.filename) === normalizedPreferred,
    );
    const best = bestCandidateForPath(candidates);
    return best ? [best] : [];
  }

  const order: string[] = [];
  const groups = new Map<string, SalvagedCodeBlock[]>();
  for (const block of extracted) {
    const key = normalizeSalvagePath(block.filename);
    if (!groups.has(key)) order.push(key);
    groups.set(key, [...(groups.get(key) ?? []), block]);
  }
  const coalesced = order
    .map((key) => bestCandidateForPath(groups.get(key) ?? []))
    .filter((block): block is SalvagedCodeBlock => block !== null);
  return inlineCompanionAssets(coalesced);
}

function normalizeSalvagePath(path: string): string {
  return path.replace(/^\.\//, '').replace(/^workspace\//, '');
}

function bestCandidateForPath(blocks: SalvagedCodeBlock[]): SalvagedCodeBlock | null {
  if (blocks.length === 0) return null;
  if (blocks.length === 1) return blocks[0]!;
  const ext = blocks[0]!.filename.split('.').at(-1)?.toLowerCase();
  const candidates =
    ext === 'js' || ext === 'mjs' || ext === 'ts'
      ? blocks.filter((block) => looksLikeStandaloneScript(block.content))
      : blocks;
  if (candidates.length === 0) return null;
  return candidates.reduce((best, block) =>
    salvageCandidateScore(block) > salvageCandidateScore(best) ? block : best,
  );
}

function looksLikeStandaloneScript(content: string): boolean {
  return /\b(?:import|export|const|let|var|function|class)\b/.test(content);
}

function salvageCandidateScore(block: SalvagedCodeBlock): number {
  let score = block.content.length;
  if (/\.html?$/i.test(block.filename)) {
    if (/<!doctype\s+html\b/i.test(block.content)) score += 1_000_000;
    if (/<\/body>\s*<\/html>\s*$/i.test(block.content)) score += 1_000_000;
  }
  return score;
}

function contentLooksLikeLang(content: string, lang: string): boolean {
  const normalized = normalizeLang(lang);
  if (normalized === 'html') {
    return /<!doctype\s+html\b|<html\b|<body\b|<script\b/i.test(content);
  }
  if (normalized === 'javascript' || normalized === 'typescript') {
    return /\b(?:const|let|var|function|document|window)\b/.test(content);
  }
  if (normalized === 'css') {
    return /[.#]?[a-zA-Z0-9_-]+\s*\{[\s\S]*\}/.test(content);
  }
  return false;
}

function salvageWriteFileFence(content: string): SalvagedCodeBlock | null {
  if (!/\bwriteFile\s*\(/.test(content)) return null;

  const pathMatch = content.match(/\bpath\s*:\s*["']([^"']+)["']/);
  const contentMatch = /\bcontent\s*:\s*`/.exec(content);
  if (!pathMatch || !contentMatch) return null;

  const filename = pathMatch[1]!.trim();
  const lang = langForFilename(filename);
  if (!filename || !lang) return null;

  const bodyStart = contentMatch.index + contentMatch[0].length;
  const bodySource = content.slice(bodyStart);
  const closeIndex = findTrailingTemplateClose(bodySource);
  const body = (closeIndex >= 0 ? bodySource.slice(0, closeIndex) : bodySource).trim();
  if (!body) return null;

  return { filename, lang, content: body };
}

function findTrailingTemplateClose(value: string): number {
  for (let i = value.length - 1; i >= 0; i--) {
    if (value[i] !== '`') continue;
    const suffix = value.slice(i + 1);
    if (/^[\s,;})]*$/.test(suffix)) return i;
  }
  return -1;
}

export function inlineCompanionAssets(blocks: SalvagedCodeBlock[]): SalvagedCodeBlock[] {
  const htmlIndex = blocks.findIndex((b) => /\.html?$/i.test(b.filename));
  if (htmlIndex < 0) return blocks;

  let html = blocks[htmlIndex]!;
  const remaining: SalvagedCodeBlock[] = [];
  let changed = false;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (i === htmlIndex) continue;
    if (/\.(?:js|mjs)$/i.test(block.filename)) {
      const nextHtml = inlineScriptBlock(html.content, block.filename, block.content);
      if (nextHtml !== html.content) {
        html = { ...html, content: nextHtml };
        changed = true;
        continue;
      }
    }
    remaining.push(block);
  }

  return changed ? [html, ...remaining] : blocks;
}

function inlineScriptBlock(html: string, filename: string, script: string): string {
  const escaped = escapeRegExp(filename);
  const srcTag = new RegExp(
    `<script\\b([^>]*)\\bsrc=["'](?:\\.\\/)?${escaped}["']([^>]*)>\\s*<\\/script>`,
    'i',
  );
  if (srcTag.test(html)) {
    return html.replace(srcTag, `<script>\n${script.trim()}\n</script>`);
  }
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `<script>\n${script.trim()}\n</script>\n</body>`);
  }
  return `${html.trim()}\n<script>\n${script.trim()}\n</script>`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
