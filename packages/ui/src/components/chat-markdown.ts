import { deriveTemplateInputs, markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';

type ChatDoc = ReturnType<typeof markdownToDoc>;
type ChatBlock = ChatDoc['blocks'][number];

/**
 * Squisq deliberately gives automatic templates a strong visual opinion. In
 * chat, preserve that richness while resolving an ambiguous signal in favour
 * of the authored structure: a list containing a short year/stat fragment is
 * still a list, not one giant statistic or an implicit section header with
 * the rows flattened beneath it.
 *
 * Explicit template annotations are untouched. This only corrects Squisq's
 * ephemeral auto-selection (or its unmarked default section-header fallback)
 * on a block whose whole body is a list.
 */
function preferStructuredListTemplates(blocks: ChatBlock[]): void {
  for (const block of blocks) {
    const soleBodyNode = block.contents?.length === 1 ? block.contents[0] : undefined;
    const hasAuthoredTemplate = Boolean(
      block.sourceHeading?.templateAnnotation?.template || block.promotedBodyAnnotation,
    );
    const isImplicitListFlatteningTemplate =
      (block.autoTemplate === true && block.template === 'statHighlight') ||
      (block.template === 'sectionHeader' && !hasAuthoredTemplate);

    if (isImplicitListFlatteningTemplate && soleBodyNode?.type === 'list') {
      const listInputs = deriveTemplateInputs('list', block.title ?? '', block.contents, {
        preserveSourceHeading: true,
      });
      if (listInputs) {
        block.template = 'list';
        block.autoTemplate = true;
        block.templateData = listInputs;
      }
    }

    if (block.children) preferStructuredListTemplates(block.children);
  }
}

/** A `$` that opens an amount: directly followed by a digit, not already escaped or doubled. */
const CURRENCY_DOLLAR = /(?<![\\$])\$(?=\d)/g;

interface PositionedNode {
  type?: string;
  position?: { start?: { offset?: number }; end?: { offset?: number } };
  children?: PositionedNode[];
}

/** Rewrite only plain prose: code spans and fenced blocks are separate nodes. */
function rewriteProse(markdown: string, rewrite: (text: string) => string): string {
  let root: PositionedNode;
  try {
    root = parseMarkdown(markdown, { math: false }) as PositionedNode;
  } catch {
    return markdown;
  }
  const ranges: Array<[number, number]> = [];
  const collect = (node: PositionedNode) => {
    if (node.type === 'text') {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (typeof start === 'number' && typeof end === 'number') ranges.push([start, end]);
      return;
    }
    for (const child of node.children ?? []) collect(child);
  };
  collect(root);
  let out = markdown;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, start) + rewrite(out.slice(start, end)) + out.slice(end);
  }
  return out;
}

const escapeCurrency = (text: string): string => text.replace(CURRENCY_DOLLAR, '\\$');

/**
 * Escape currency dollars in prose so they survive inline-math parsing.
 *
 * Squisq always enables single-dollar inline math, so "budget about $300. Our
 * prices: croissants $3.50" parsed as one math span and rendered as a code
 * span with both dollar signs gone — business figures mangled in the
 * user's own message. Only `$` followed by a digit is escaped, and only inside
 * plain text: code spans and fenced blocks keep their literal `$`, and real
 * math such as `$x^2$` still renders.
 */
export function escapeCurrencyDollars(markdown: string): string {
  if (!markdown.includes('$')) return markdown;
  return rewriteProse(markdown, escapeCurrency);
}

/** LaTeX symbol commands models write in prose, as the characters they typeset. */
const LATEX_SYMBOLS: Record<string, string> = {
  rightarrow: '→',
  to: '→',
  longrightarrow: '⟶',
  leftarrow: '←',
  gets: '←',
  longleftarrow: '⟵',
  leftrightarrow: '↔',
  Rightarrow: '⇒',
  implies: '⇒',
  Leftarrow: '⇐',
  Leftrightarrow: '⇔',
  iff: '⇔',
  uparrow: '↑',
  downarrow: '↓',
  mapsto: '↦',
  times: '×',
  div: '÷',
  cdot: '·',
  pm: '±',
  mp: '∓',
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  ne: '≠',
  neq: '≠',
  approx: '≈',
  sim: '∼',
  equiv: '≡',
  propto: '∝',
  infty: '∞',
  ldots: '…',
  dots: '…',
  cdots: '⋯',
  degree: '°',
  circ: '∘',
  in: '∈',
  notin: '∉',
  forall: '∀',
  exists: '∃',
  therefore: '∴',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  Delta: 'Δ',
  epsilon: 'ε',
  theta: 'θ',
  lambda: 'λ',
  mu: 'μ',
  pi: 'π',
  sigma: 'σ',
  Sigma: 'Σ',
  omega: 'ω',
  Omega: 'Ω',
};

/** Arrows are safe to replace even outside `$…$`; `\alpha` could be a path segment. */
const BARE_ARROW =
  /\\(rightarrow|longrightarrow|leftarrow|longleftarrow|leftrightarrow|Rightarrow|Leftarrow|Leftrightarrow|mapsto)(?![A-Za-z])/g;

/** Next single `$` at or after `from`: not escaped and not half of a `$$` pair. */
function nextMathDollar(text: string, from: number): number {
  for (let i = text.indexOf('$', from); i >= 0; i = text.indexOf('$', i + 1)) {
    if (text[i - 1] !== '\\' && text[i - 1] !== '$' && text[i + 1] !== '$') return i;
  }
  return -1;
}

/**
 * Replace each symbol-only `$…$` span. A candidate that does not convert
 * gives up only its opening `$`, so "$300 $\rightarrow$ $250" still pairs
 * the arrow's own dollars.
 */
function replaceSymbolMath(text: string): string {
  let out = '';
  let at = 0;
  for (let open = nextMathDollar(text, 0); open >= 0; open = nextMathDollar(text, at)) {
    const close = nextMathDollar(text, open + 1);
    if (close < 0) break;
    const body = text.slice(open + 1, close);
    const converted = body.includes('\n') ? null : symbolMath(body);
    if (converted === null) {
      out += text.slice(at, open + 1);
      at = open + 1;
    } else {
      out += text.slice(at, open) + converted;
      at = close + 1;
    }
  }
  return out + text.slice(at);
}

/** What may sit between a span's symbol commands: words, numbers, plain operators. */
const PLAIN_MATH_REST = /^[\p{L}\p{N}\s.,:;+\-=<>()%/*'|!?]*$/u;

/** A span made only of known symbol commands and plain text, as Unicode; else null. */
function symbolMath(body: string): string | null {
  let commands = 0;
  let unknown = false;
  const rest = body.replace(/\\([A-Za-z]+)/g, (_match, name: string) => {
    if (name in LATEX_SYMBOLS) commands++;
    else unknown = true;
    return '';
  });
  if (commands === 0 || unknown || !PLAIN_MATH_REST.test(rest)) return null;
  return body.replace(/\\([A-Za-z]+)/g, (_match, name: string) => LATEX_SYMBOLS[name]!).trim();
}

const latexSymbols = (text: string): string =>
  replaceSymbolMath(text).replace(BARE_ARROW, (_match, name: string) => LATEX_SYMBOLS[name]!);

/**
 * Prose rewrites every chat bubble needs before parsing: symbol-only LaTeX
 * becomes the characters it stands for, then currency dollars are escaped.
 * Nothing typesets math in a chat bubble, so a model's `$\rightarrow$`
 * rendered as a literal `\rightarrow` code span. Real formulas (`$x^2$`,
 * `\frac`) are left for the math renderer.
 */
export function prepareChatMarkdown(markdown: string): string {
  if (!markdown.includes('$') && !markdown.includes('\\')) return markdown;
  return rewriteProse(markdown, (text) => escapeCurrency(latexSymbols(text)));
}

/**
 * Convert parsed Markdown into the opinionated-but-readable chat rendition.
 *
 * No cover block: Squisq's default promotes the first shallowest heading to a
 * page title with its first paragraph as a subtitle. A chat reply is not an
 * article, so that rendered as a giant centered heading above the opening
 * paragraph — and then again in place, because the cover is only de-duplicated
 * when the reply happens to begin with that heading.
 */
export function markdownToChatDoc(
  markdown: Parameters<typeof markdownToDoc>[0],
  options?: Parameters<typeof markdownToDoc>[1],
): ChatDoc {
  const doc = markdownToDoc(markdown, { generateCoverBlock: false, ...options });
  preferStructuredListTemplates(doc.blocks);
  return doc;
}
