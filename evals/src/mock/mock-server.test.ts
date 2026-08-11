import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyBinaryDocumentBytes } from '@bendyline/gezel';
import { afterEach, describe, expect, it } from 'vitest';
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
