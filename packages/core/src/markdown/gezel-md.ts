import matter from 'gray-matter';
import { GezelFrontmatterSchema, type GezelSection, type ParsedGezel } from '../schemas/gezel.js';

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const TEMPLATE_RE = /\{\[\s*([a-zA-Z_][\w-]*)\s*([^\]]*)\]\}\s*$/;

/**
 * Parse an `agent.md` source string into frontmatter + sections.
 *
 * Sections are split on top-level headings (the lowest heading level used in
 * the document). Each section's heading may carry a template annotation —
 * `### Memory {[memory color=blue]}` — matching the Squisq editor convention.
 * We extract the template name and key=value params and store the clean
 * heading text.
 */
export function parseGezelMarkdown(source: string): ParsedGezel {
  const parsed = matter(source);
  const frontmatter = GezelFrontmatterSchema.parse({
    name: 'Untitled agent',
    ...parsed.data,
  });

  const lines = parsed.content.split(/\r?\n/);
  const headings = collectHeadings(lines);

  if (headings.length === 0) {
    return {
      frontmatter,
      sections: [
        {
          heading: '',
          body: parsed.content.trim(),
        },
      ],
      source,
    };
  }

  // Use the minimum heading level as the "section" level so nested headings
  // stay within their parent section.
  const topLevel = Math.min(...headings.map((h) => h.level));
  const sectionStarts = headings.filter((h) => h.level === topLevel);

  const sections: GezelSection[] = [];
  for (let i = 0; i < sectionStarts.length; i++) {
    const start = sectionStarts[i]!;
    const next = sectionStarts[i + 1];
    const bodyLines = lines.slice(start.lineIndex + 1, next ? next.lineIndex : lines.length);
    const body = bodyLines.join('\n').trim();
    const { heading, template, params } = parseHeadingAnnotation(start.text);
    sections.push({
      heading,
      body,
      ...(template ? { template } : {}),
      ...(params && Object.keys(params).length > 0 ? { params } : {}),
    });
  }

  return { frontmatter, sections, source };
}

interface HeadingHit {
  lineIndex: number;
  level: number;
  text: string;
}

function collectHeadings(lines: string[]): HeadingHit[] {
  const out: HeadingHit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = HEADING_RE.exec(line);
    if (m) out.push({ lineIndex: i, level: m[1]!.length, text: m[2]! });
  }
  return out;
}

function parseHeadingAnnotation(raw: string): {
  heading: string;
  template?: string;
  params?: Record<string, string>;
} {
  const m = TEMPLATE_RE.exec(raw);
  if (!m) return { heading: raw.trim() };
  const heading = raw.slice(0, m.index).trim();
  const template = m[1]!;
  const params = parseParams(m[2] ?? '');
  return { heading, template, params };
}

function parseParams(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_][\w-]*)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
  while ((m = re.exec(src)) !== null) {
    out[m[1]!] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

/**
 * Serialize a ParsedGezel back to markdown. Round-trips frontmatter via
 * gray-matter and reconstructs sections with their template annotations.
 */
export function serializeGezelMarkdown(parsed: ParsedGezel): string {
  const body = parsed.sections
    .map((section) => {
      const annotation = section.template
        ? ` {[${section.template}${formatParams(section.params)}]}`
        : '';
      const heading = section.heading ? `## ${section.heading}${annotation}\n\n` : '';
      return `${heading}${section.body}`.trimEnd();
    })
    .join('\n\n');
  return matter.stringify(`${body}\n`, parsed.frontmatter);
}

function formatParams(params: Record<string, string> | undefined): string {
  if (!params) return '';
  const keys = Object.keys(params);
  if (keys.length === 0) return '';
  return ` ${keys.map((k) => `${k}=${quoteIfNeeded(params[k]!)}`).join(' ')}`;
}

function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}
