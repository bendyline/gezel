import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledDocblocksToolset } from '@bendyline/gezel-service';
import { describe, expect, it } from 'vitest';
import { buildPptx } from '../fixtures/office-documents.ts';
import {
  BRAND_DECK_PATH,
  BRAND_THEME,
  REVIEW_SOURCE,
  REVIEW_SOURCE_PATH,
  THEME_FACTS,
  type ThemeEvidence,
  brandDeckBytes,
  checkThemeReport,
  compareEvidence,
  pptxCarriesBrandFonts,
  pptxSlideCount,
} from './docblocks-theme-roundtrip.ts';

const EVIDENCE: ThemeEvidence = {
  slideCount: 4,
  comparePercents: ['21%', '25%', '100%', '43%'],
  compareEquivalent: false,
};

function validReport(): string {
  return [
    '# Brand theme alignment',
    '',
    '## Theme applied',
    `Inferred theme ${THEME_FACTS.themeId} from the brand reference. Headings use`,
    `${THEME_FACTS.headingFont}; body copy uses ${THEME_FACTS.bodyFont}. Primary`,
    `${THEME_FACTS.primaryHex} on background ${THEME_FACTS.backgroundHex}.`,
    '',
    '## Slide count',
    'The themed deck has 4 slides, one per section of the review.',
    '',
    '## What changed',
    'compare_documents rated text similarity at 21% and structure at 25%: the deck',
    'carries the content as slides, not as the original paragraphs.',
    '',
    '## Recommendation',
    'Ship the themed deck for review and ask the brand team to confirm the title slide',
    'before the next quarterly cycle.',
  ].join('\n');
}

describe('docblocks theme report grader', () => {
  it('accepts a fully tool-grounded report', () => {
    const result = checkThemeReport(validReport(), EVIDENCE);
    expect(result.ok).toBe(true);
    expect(result.score).toBe(result.scoreMax);
  });

  it('rejects a plausible but invented font', () => {
    const result = checkThemeReport(
      validReport().replace(THEME_FACTS.bodyFont, 'Source Serif'),
      EVIDENCE,
    );
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toContain('fonts');
  });

  it('rejects a near-miss hex color', () => {
    const result = checkThemeReport(
      validReport().replace(THEME_FACTS.primaryHex, '#2E5E4F'),
      EVIDENCE,
    );
    expect(result.missingRequiredSignals).toContain('palette');
  });

  it("rejects a slide count that is not the saved deck's", () => {
    const result = checkThemeReport(validReport(), { ...EVIDENCE, slideCount: 5 });
    expect(result.missingRequiredSignals).toEqual(['slide-count']);
    expect(checkThemeReport(validReport(), { ...EVIDENCE, slideCount: null }).failReason).toContain(
      'save the themed deck',
    );
  });

  it('rejects a comparison figure no compare_documents call returned', () => {
    const result = checkThemeReport(validReport(), { ...EVIDENCE, comparePercents: ['37%'] });
    expect(result.missingRequiredSignals).toEqual(['compare-cited']);
    expect(
      checkThemeReport(validReport(), { ...EVIDENCE, comparePercents: [] }).failReason,
    ).toContain('call compare_documents');
  });

  it('does not take 121% for a quoted 21%', () => {
    const report = validReport().replace('at 21% and structure at 25%', 'at 121%');
    expect(checkThemeReport(report, EVIDENCE).missingRequiredSignals).toContain('compare-cited');
  });

  it('rejects a report that calls a degraded comparison a clean carry-over', () => {
    const report = validReport().replace(
      'the deck\ncarries the content as slides, not as the original paragraphs.',
      'the deck\nis identical to the source.',
    );
    expect(checkThemeReport(report, EVIDENCE).missingRequiredSignals).toContain(
      'differences-not-whitewashed',
    );
    expect(checkThemeReport(report, { ...EVIDENCE, compareEquivalent: true }).ok).toBe(true);
  });

  it('allows a qualified "identical except" phrasing', () => {
    const report = validReport().replace(
      'the deck\ncarries the content as slides, not as the original paragraphs.',
      'the text is identical except that each section became its own slide.',
    );
    expect(checkThemeReport(report, EVIDENCE).ok).toBe(true);
  });

  it('rejects an empty Recommendation section', () => {
    const report = validReport().replace(/## Recommendation[\s\S]*$/, '## Recommendation\n');
    expect(checkThemeReport(report, EVIDENCE).missingRequiredSignals).toContain('recommendation');
  });

  it('accepts H1 sections — heading depth is presentation, not capability', () => {
    const report = validReport().replace(/^## /gm, '# ');
    expect(checkThemeReport(report, EVIDENCE).ok).toBe(true);
  });

  it('still rejects sections that are out of order', () => {
    const report = validReport()
      .replace('## Slide count', '## TEMP')
      .replace('## What changed', '## Slide count')
      .replace('## TEMP', '## What changed');
    expect(checkThemeReport(report, EVIDENCE).missingRequiredSignals).toContain('ordered-sections');
  });

  it('still rejects a missing section at any depth', () => {
    const report = validReport().replace('## What changed', '## Changes');
    expect(checkThemeReport(report, EVIDENCE).missingRequiredSignals).toContain('ordered-sections');
  });
});

describe('theme fixtures', () => {
  it('keeps every gated value out of the text the model can read directly', () => {
    const seeded = REVIEW_SOURCE.toLowerCase();
    for (const value of [
      THEME_FACTS.themeId,
      THEME_FACTS.headingFont,
      THEME_FACTS.bodyFont,
      THEME_FACTS.primaryHex,
      THEME_FACTS.backgroundHex,
    ]) {
      expect(seeded, `"${value}" must not be guessable from the seeded review`).not.toContain(
        value.toLowerCase(),
      );
    }
  });

  it('puts the brand into the deck the theme is inferred from', () => {
    const bytes = brandDeckBytes();
    expect(pptxSlideCount(bytes)).toBe(2);
    expect(pptxCarriesBrandFonts(bytes)).toBe(true);
    const plain = buildPptx([{ title: 'Plain' }], {
      ...BRAND_THEME,
      headingFont: 'Calibri Light',
      bodyFont: 'Calibri',
    });
    expect(pptxCarriesBrandFonts(plain)).toBe(false);
  });

  it("reads the figures and verdict out of compare_documents' recorded result", () => {
    const resultText = JSON.stringify({
      kind: 'comparison',
      equivalent: false,
      score: 0.425325,
      changes: [
        { category: 'text', status: 'degraded', message: 'Text content similarity is 21%.' },
        {
          category: 'structure',
          status: 'degraded',
          message: 'Document structure similarity is 25%.',
        },
      ],
    });
    const evidence = compareEvidence([
      { name: 'compare_documents', success: true, resultText },
      { name: 'compare_documents', success: false, resultText: '"equivalent": true 99%' },
    ]);
    expect(evidence).toEqual({ percents: ['21%', '25%', '43%'], equivalent: false });
  });
});

/** Drive the bundled DocBlocks over stdio, the way a session's bridge does. */
async function callDocblocks(
  workspace: string,
  artifacts: string,
  calls: Array<{ name: string; args: (roots: Record<string, string>) => Record<string, unknown> }>,
): Promise<Array<Record<string, unknown>>> {
  const { installPath = '', runtime } = bundledDocblocksToolset();
  if (runtime.kind !== 'npm-package') throw new Error('Bundled DocBlocks npm runtime is missing');
  const child = spawn(
    process.execPath,
    [
      join(installPath, runtime.entry),
      'mcp',
      '--allow-read',
      workspace,
      artifacts,
      '--allow-write',
      artifacts,
    ],
    { stdio: ['pipe', 'pipe', 'ignore'] },
  );
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;
      const message = JSON.parse(line) as { id?: number };
      if (typeof message.id === 'number') waiting.get(message.id)?.(message);
    }
  });
  let nextId = 0;
  const rpc = (method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = ++nextId;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const structured = (message: Record<string, unknown>) => {
    const result = message.result as {
      structuredContent?: unknown;
      content?: Array<{ text?: string }>;
    };
    return (result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? '{}')) as Record<
      string,
      unknown
    >;
  };
  try {
    await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'eval-test', version: '1' },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    const listed = structured(await rpc('tools/call', { name: 'list_roots', arguments: {} })) as {
      roots: Array<{ id: string; label: string }>;
    };
    const roots = Object.fromEntries(listed.roots.map((root) => [root.label, root.id]));
    const out: Array<Record<string, unknown>> = [];
    for (const call of calls) {
      out.push(
        structured(await rpc('tools/call', { name: call.name, arguments: call.args(roots) })),
      );
    }
    return out;
  } finally {
    child.kill();
  }
}

describe('the bundled DocBlocks on the brand deck', () => {
  it('infers exactly the theme the grader expects', { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'theme-roundtrip-'));
    try {
      const workspace = join(root, 'workspace');
      const artifacts = join(root, 'artifacts');
      await mkdir(join(workspace, 'source'), { recursive: true });
      await mkdir(artifacts, { recursive: true });
      await writeFile(join(workspace, BRAND_DECK_PATH), brandDeckBytes());
      await writeFile(join(workspace, REVIEW_SOURCE_PATH), REVIEW_SOURCE);
      const [inferred] = await callDocblocks(workspace, artifacts, [
        {
          name: 'infer_theme_from_file',
          args: (roots) => ({
            source: { kind: 'file', rootId: roots.workspace, path: BRAND_DECK_PATH },
          }),
        },
      ]);
      const text = JSON.stringify(inferred);
      expect(text).toContain(`"id":"${THEME_FACTS.themeId}"`);
      for (const value of [
        THEME_FACTS.headingFont,
        THEME_FACTS.bodyFont,
        THEME_FACTS.primaryHex.toLowerCase(),
        THEME_FACTS.backgroundHex.toLowerCase(),
      ]) {
        expect(text.toLowerCase()).toContain(value.toLowerCase());
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
