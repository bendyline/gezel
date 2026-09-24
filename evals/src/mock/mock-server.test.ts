import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyBinaryDocumentBytes } from '@bendyline/gezel';
import { afterEach, describe, expect, it } from 'vitest';
import { readStoredZip } from '../fixtures/office-documents.ts';
import {
  evaluateMockExpectations,
  materializeMockToolFixture,
  minimalDocxFixture,
  minimalPdfFixture,
  minimalPngFixture,
  minimalPptxFixture,
  mockMcpUsesSystemSeed,
} from './mock-server.js';

let home: string | undefined;

afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  home = undefined;
});

describe('mock MCP file fixtures', () => {
  it('routes scoped runtime ids to the system roster and catalog ids to local manifests', () => {
    expect(mockMcpUsesSystemSeed('playwright', '@playwright/mcp')).toBe(true);
    expect(mockMcpUsesSystemSeed('alerts')).toBe(false);
    expect(mockMcpUsesSystemSeed('alerts', 'alerting')).toBe(false);
  });

  it('writes a deterministic PPTX-shaped ZIP to the bound artifact path', async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-mock-mcp-'));
    await materializeMockToolFixture(
      {
        surface: 'artifact',
        pathArgument: 'destination.path',
        fixture: 'minimal-pptx',
      },
      { destination: { path: 'deliverables/d-day.pptx' } },
      { trialHome: home, projectId: 'pptx-eval' },
    );

    const bytes = await readFile(
      join(home, 'projects', 'pptx-eval', 'artifacts', 'deliverables', 'd-day.pptx'),
    );
    expect(bytes.length).toBeGreaterThan(1_000);
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(Buffer.from(bytes).includes(Buffer.from('ppt/presentation.xml'))).toBe(true);
    expect(bytes).toEqual(Buffer.from(minimalPptxFixture()));
  });

  it('dispatches on the requested fixture instead of always writing a PPTX', async () => {
    // Regression: `effect.fixture` was read from the spec and ignored, so
    // every effect wrote a presentation — a `.docx` deliverable would have
    // been materialized as a PPTX and passed a byte floor unnoticed.
    home = await mkdtemp(join(tmpdir(), 'gezel-mock-mcp-'));
    const cases = [
      ['minimal-pptx', 'out/deck.pptx', minimalPptxFixture()],
      ['minimal-docx', 'out/report.docx', minimalDocxFixture()],
      ['minimal-pdf', 'out/report.pdf', minimalPdfFixture()],
    ] as const;

    for (const [fixture, path, expected] of cases) {
      await materializeMockToolFixture(
        { surface: 'artifact', pathArgument: 'destination.path', fixture },
        { destination: { path } },
        { trialHome: home, projectId: 'fixture-eval' },
      );
      const bytes = await readFile(join(home, 'projects', 'fixture-eval', 'artifacts', path));
      expect(bytes, fixture).toEqual(Buffer.from(expected));
      // Each fixture must satisfy the container its own path claims.
      expect(verifyBinaryDocumentBytes(path, new Uint8Array(bytes)).ok, fixture).toBe(true);
    }

    // …and the fixtures are genuinely different containers.
    expect(Buffer.from(minimalDocxFixture())).not.toEqual(Buffer.from(minimalPptxFixture()));
    expect(verifyBinaryDocumentBytes('x.pdf', minimalPptxFixture()).ok).toBe(false);
  });

  it('builds PPTX and DOCX fixtures from the converted source instead of a placeholder', async () => {
    // Regression: every save wrote the fixed one-slide "Deterministic DocBlocks
    // eval deck", so powerpoint-deck's evaluate step — which reads the saved
    // deck back with the real read_doc_as_markdown — correctly failed content
    // fidelity and looped evaluate → publish until the retry-loop verdict.
    home = await mkdtemp(join(tmpdir(), 'gezel-mock-mcp-'));
    const source = {
      markdown: '# Pilot Scope\n- 18 SKUs\n\n# Next Actions\n- Automated status emails\n',
      origin: 'workspace/powerpoint/eval/deck.md',
      slideBreak: 'h1' as const,
    };
    const pptx = await materializeMockToolFixture(
      { surface: 'artifact', pathArgument: 'destination.path', fixture: 'minimal-pptx' },
      { destination: { path: 'tasks/1/deck.pptx' } },
      { trialHome: home, projectId: 'pptx-eval', source },
    );
    const docx = await materializeMockToolFixture(
      { surface: 'artifact', pathArgument: 'destination.path', fixture: 'minimal-docx' },
      { destination: { path: 'tasks/1/report.docx' } },
      { trialHome: home, projectId: 'pptx-eval', source },
    );
    expect(pptx.materializedFrom).toBe('workspace/powerpoint/eval/deck.md');
    expect(docx.materializedFrom).toBe('workspace/powerpoint/eval/deck.md');

    const artifacts = join(home, 'projects', 'pptx-eval', 'artifacts', 'tasks', '1');
    const deck = readStoredZip(new Uint8Array(await readFile(join(artifacts, 'deck.pptx'))));
    expect(deck.get('ppt/slides/slide1.xml')).toContain('<a:t>Pilot Scope</a:t>');
    expect(deck.get('ppt/slides/slide2.xml')).toContain('<a:t>Automated status emails</a:t>');
    expect(deck.has('ppt/slides/slide3.xml')).toBe(false);
    const report = readStoredZip(new Uint8Array(await readFile(join(artifacts, 'report.docx'))));
    expect(report.get('word/document.xml')).toContain('Next Actions');
    for (const [path, bytes] of [
      ['deck.pptx', deck],
      ['report.docx', report],
    ] as const) {
      expect([...bytes.values()].join(''), path).not.toContain('Deterministic DocBlocks eval');
    }
  });

  it('keeps the fixed fixture when no source resolves, and for formats nothing reads back', async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-mock-mcp-'));
    const noSource = await materializeMockToolFixture(
      { surface: 'artifact', pathArgument: 'destination.path', fixture: 'minimal-pptx' },
      { destination: { path: 'deck.pptx' } },
      { trialHome: home, projectId: 'fallback-eval', source: null },
    );
    const pdf = await materializeMockToolFixture(
      { surface: 'artifact', pathArgument: 'destination.path', fixture: 'minimal-pdf' },
      { destination: { path: 'report.pdf' } },
      {
        trialHome: home,
        projectId: 'fallback-eval',
        source: { markdown: '# Report\n', origin: 'workspace/report.md' },
      },
    );
    const emptySource = await materializeMockToolFixture(
      { surface: 'artifact', pathArgument: 'destination.path', fixture: 'minimal-pptx' },
      { destination: { path: 'empty.pptx' } },
      {
        trialHome: home,
        projectId: 'fallback-eval',
        source: { markdown: '\n', origin: 'workspace/empty.md' },
      },
    );
    expect(noSource.materializedFrom).toBe('fixed minimal-pptx fixture');
    expect(pdf.materializedFrom).toBe('fixed minimal-pdf fixture');
    expect(emptySource.materializedFrom).toBe('fixed minimal-pptx fixture');
    const artifacts = join(home, 'projects', 'fallback-eval', 'artifacts');
    expect(await readFile(join(artifacts, 'deck.pptx'))).toEqual(Buffer.from(minimalPptxFixture()));
    expect(await readFile(join(artifacts, 'report.pdf'))).toEqual(Buffer.from(minimalPdfFixture()));
    expect(await readFile(join(artifacts, 'empty.pptx'))).toEqual(
      Buffer.from(minimalPptxFixture()),
    );
  });

  it('still refuses a destination outside the project when it has a source', async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-mock-mcp-'));
    await expect(
      materializeMockToolFixture(
        { surface: 'artifact', pathArgument: 'destination.path', fixture: 'minimal-pptx' },
        { destination: { path: '../../escape.pptx' } },
        {
          trialHome: home,
          projectId: 'pptx-eval',
          source: { markdown: '# Slide\n', origin: 'workspace/deck.md', slideBreak: 'h1' },
        },
      ),
    ).rejects.toThrow(/inside the project/);
  });

  it('materializes a real PNG screenshot stub above the image-gate floor', async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-mock-mcp-'));
    await materializeMockToolFixture(
      { surface: 'workspace', pathArgument: 'path', fixture: 'minimal-png' },
      { path: 'qa/screenshots/mobile.png' },
      { trialHome: home, projectId: 'browser-eval' },
    );

    const bytes = await readFile(
      join(home, 'projects', 'browser-eval', 'workspace', 'qa', 'screenshots', 'mobile.png'),
    );
    expect(bytes.length).toBeGreaterThan(1_024);
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(bytes).toEqual(Buffer.from(minimalPngFixture()));
  });

  it('enforces per-tool MCP call budgets', () => {
    const service = {
      id: 'browser',
      kind: 'mcp' as const,
      baseUrl: 'https://127.0.0.1:1',
      credentialName: null,
      token: null,
      requests: [
        {
          at: new Date().toISOString(),
          method: 'POST',
          path: 'tools/call:browser_click',
          matchedRoute: 'tools/call browser_click',
          status: 200,
          authorized: true,
        },
      ],
    };
    const failures = evaluateMockExpectations(
      [
        {
          service: 'browser',
          toolCalls: {
            browser_click: { minCalls: 2 },
            browser_resize: { minCalls: 1, maxCalls: 2 },
          },
        },
      ],
      { services: new Map([['browser', service]]) },
    );

    expect(failures).toEqual([
      expect.stringContaining('browser_click'),
      expect.stringContaining('browser_resize'),
    ]);
  });

  it('fails closed when the scenario has not bound a trial project', async () => {
    await expect(
      materializeMockToolFixture(
        {
          surface: 'artifact',
          pathArgument: 'destination.path',
          fixture: 'minimal-pptx',
        },
        { destination: { path: 'deck.pptx' } },
        { projectId: null },
      ),
    ).rejects.toThrow(/no bound trial project/i);
  });
});
