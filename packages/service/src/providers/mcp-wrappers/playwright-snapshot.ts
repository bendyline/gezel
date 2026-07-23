/**
 * Playwright MCP — snapshot inliner + normalizer.
 *
 * `@playwright/mcp` writes the page accessibility tree to a YAML file on
 * disk and returns a relative `[Snapshot](path/to/page.yml)` link. Frontier
 * models can be coached into a two-step ritual (`browser_navigate` →
 * `browser_snapshot`); small local models can't, and tend to fabricate
 * page content rather than chain calls.
 *
 * This wrapper does four things to make that snapshot directly useful:
 *
 *   1. Reads the YAML file referenced by each `[Snapshot](path)` link.
 *   2. Strips cosmetic annotations (`[cursor=pointer]`) — pure noise.
 *   3. Extracts a flat URL list (visible-text → href) and an
 *      interactive-element ref index (role/name/ref) and prepends them
 *      as their own markdown sections, so a small model has a fast
 *      lookup table for the next action.
 *   4. Inlines the cleaned aria tree as a yaml code block.
 *
 * The original `[Snapshot](path)` link stays in place so the file
 * remains diff-able / re-readable; everything else is additive.
 *
 * Cap is generous (~50 KB ≈ 12 K tokens) but firm — the bridge's outer
 * `MAX_TOOL_OUTPUT_CHARS` is 80 KB, so a giant page can still get
 * truncated by the bridge after this layer runs.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { McpServerSpec } from '../mcp-bridge.js';
import {
  extractRefIndex,
  extractUrls,
  formatRefIndex,
  formatUrlList,
  stripNoise,
} from './playwright-yaml.js';
import type { McpToolResult, McpToolWrapper, McpToolWrapperContext } from './types.js';

const SNAPSHOT_LINK_RE = /^- \[Snapshot\]\(([^)]+)\)\s*$/gm;
const MAX_INLINE_BYTES = 50_000;

export function isPlaywrightMcp(spec: McpServerSpec): boolean {
  // @playwright/mcp is a system-bootstrapped stdio subprocess; an
  // http-mcp registry entry can't be it. Short-circuit before the
  // haystack check so we don't dereference the stdio-specific
  // `command`/`args` fields on an http spec.
  if (spec.kind === 'http') return false;
  const haystack = [spec.command, ...spec.args].join(' ');
  return haystack.includes('@playwright/mcp') || haystack.includes('playwright-mcp');
}

async function readCapped(absolute: string): Promise<{ content: string; truncated: number }> {
  const stat = await fs.stat(absolute);
  if (stat.size <= MAX_INLINE_BYTES) {
    return { content: await fs.readFile(absolute, 'utf-8'), truncated: 0 };
  }
  const fd = await fs.open(absolute, 'r');
  try {
    const buf = Buffer.alloc(MAX_INLINE_BYTES);
    await fd.read(buf, 0, MAX_INLINE_BYTES, 0);
    return { content: buf.toString('utf-8'), truncated: stat.size - MAX_INLINE_BYTES };
  } finally {
    await fd.close();
  }
}

function buildEnhancedBlock(yaml: string, truncatedBytes: number): string {
  const cleaned = stripNoise(yaml).trimEnd();
  const urls = extractUrls(cleaned);
  const refs = extractRefIndex(cleaned);

  const sections: string[] = [];

  if (refs.length > 0) {
    sections.push(`#### Interactive elements (${refs.length})`);
    sections.push(formatRefIndex(refs));
  }
  if (urls.length > 0) {
    sections.push(`#### Links on this page (${urls.length})`);
    sections.push(formatUrlList(urls));
  }

  // Truncation note never references a path — the OutboardStorage
  // wrapper running after this one persists the FULL content to a
  // stable `auto/<tool>/...` artifact and surfaces that path in its
  // summary. Mentioning Playwright's internal `.playwright-mcp/`
  // path here would put a SECOND, conflicting path in the model's
  // view; observed wild as the model occasionally chose the
  // .playwright-mcp/ one for `grep_artifact` (which then fails
  // because that's not under the project's artifacts root).
  const trailer =
    truncatedBytes > 0
      ? `\n# ... (snapshot truncated: ${truncatedBytes.toLocaleString('en-US')} more bytes — read the full artifact via read_artifact)`
      : '';
  sections.push('#### Aria tree');
  sections.push(`\`\`\`yaml\n${cleaned}${trailer}\n\`\`\``);

  return sections.join('\n\n');
}

async function inlineOne(
  match: { full: string; relativePath: string },
  ctx: McpToolWrapperContext,
): Promise<string | null> {
  const absolute = path.isAbsolute(match.relativePath)
    ? match.relativePath
    : path.resolve(ctx.cwd, match.relativePath);
  let content: string;
  let truncated: number;
  try {
    ({ content, truncated } = await readCapped(absolute));
  } catch {
    return null;
  }
  // Drop the original `[Snapshot](.playwright-mcp/...)` link
  // (`match.full`) — once we inline the YAML body, the raw path is
  // confusing baggage. The OutboardStorage wrapper running after
  // this one re-saves the enhanced output to `auto/<tool>/...`
  // under the project's artifacts root and surfaces THAT path in
  // its summary. Keeping the raw `.playwright-mcp/` reference here
  // means the model sees TWO paths, occasionally picks the wrong
  // one for `grep_artifact`, and gets a confusing "not found"
  // error (the .playwright-mcp/ tree isn't under artifacts).
  return buildEnhancedBlock(content, truncated);
}

export const PlaywrightSnapshotInliner: McpToolWrapper = {
  id: 'playwright-snapshot-inliner',
  matches: isPlaywrightMcp,
  async postProcess(
    _toolName: string,
    _args: Record<string, unknown>,
    result: McpToolResult,
    ctx: McpToolWrapperContext,
  ): Promise<McpToolResult> {
    const text = result.text;
    if (!text || !text.includes('[Snapshot](')) return result;

    const matches: Array<{ full: string; relativePath: string; index: number; length: number }> =
      [];
    SNAPSHOT_LINK_RE.lastIndex = 0;
    while (true) {
      const m = SNAPSHOT_LINK_RE.exec(text);
      if (m === null) break;
      const relativePath = m[1];
      if (!relativePath) continue;
      matches.push({ full: m[0], relativePath, index: m.index, length: m[0].length });
    }
    if (matches.length === 0) return result;

    const replacements = await Promise.all(
      matches.map(async (m) => ({ m, replacement: await inlineOne(m, ctx) })),
    );

    let out = '';
    let cursor = 0;
    for (const { m, replacement } of replacements) {
      out += text.slice(cursor, m.index);
      out += replacement ?? m.full;
      cursor = m.index + m.length;
    }
    out += text.slice(cursor);

    return { text: out, images: result.images };
  },
};
