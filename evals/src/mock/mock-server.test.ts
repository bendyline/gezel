import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyBinaryDocumentBytes } from '@bendyline/gezel';
import { afterEach, describe, expect, it } from 'vitest';
import {
  materializeMockToolFixture,
  minimalDocxFixture,
  minimalPdfFixture,
  minimalPptxFixture,
} from './mock-server.js';

let home: string | undefined;

afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  home = undefined;
});

describe('mock MCP file fixtures', () => {
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
