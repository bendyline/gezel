import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyBinaryDocumentBytes } from '@bendyline/gezel';
import { afterEach, describe, expect, it } from 'vitest';
import { materializeMockToolFixture } from './mock-server.ts';

let home: string | undefined;
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  home = undefined;
});

describe('fixture path tolerance', () => {
  // Wild-caught: the model sent `destinationPath`; the spec declared
  // `destination.path`. The tool logged as called, the write threw, and the
  // trial failed on a missing DOCX with every provenance check green.
  it.each([
    ['nested as declared', { destination: { path: 'report.docx' } }],
    ['flat camelCase', { destinationPath: 'report.docx' }],
    ['bare path', { path: 'report.docx' }],
  ])('accepts %s', async (_label, args) => {
    home = await mkdtemp(join(tmpdir(), 'gezel-fixpath-'));
    await materializeMockToolFixture(
      { surface: 'artifact', pathArgument: 'destination.path', fixture: 'minimal-docx' },
      args,
      { trialHome: home, projectId: 'p' },
    );
    const bytes = await readFile(join(home, 'projects', 'p', 'artifacts', 'report.docx'));
    expect(verifyBinaryDocumentBytes('report.docx', new Uint8Array(bytes)).ok).toBe(true);
  });

  it('still fails loudly when no path can be found at all', async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-fixpath-'));
    await expect(
      materializeMockToolFixture(
        { surface: 'artifact', pathArgument: 'destination.path', fixture: 'minimal-docx' },
        { unrelated: 1 },
        { trialHome: home, projectId: 'p' },
      ),
    ).rejects.toThrow(/could not resolve a destination path/);
  });
});
