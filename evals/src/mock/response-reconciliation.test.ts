import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { craftbookEvalSpecMap } from '../craftbooks/specs.ts';
import { readStoredZip } from '../fixtures/office-documents.ts';
import { type MockServicesRuntime, minimalPptxFixture, startMockServices } from './mock-server.ts';
import { createMockDocumentLedger, reconcileMockResponse } from './response-reconciliation.ts';

const PROJECT = 'pptx-eval';
const DECK_MD = 'powerpoint/eval/deck.md';
const SAVED = 'tasks/1/deck.pptx';
const DELIVERABLE = 'deliverables/halvard-pilot.pptx';

let home: string | undefined;
let runtime: MockServicesRuntime | null = null;
let client: Client | null = null;
let previousTls: string | undefined;

afterEach(async () => {
  await client?.close();
  client = null;
  await runtime?.close();
  runtime = null;
  if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
  if (home) await rm(home, { recursive: true, force: true });
  home = undefined;
});

/** A deck with `count` H1 slides; the H2 inside each proves the requested h1 break is honored. */
function deckOf(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `# Slide ${index + 1}\n\n## Detail\n\n- Fact ${index + 1}: 4 berths\n`,
  ).join('\n');
}

const drawerPath = (drawer: 'workspace' | 'artifacts', path: string) =>
  join(home!, 'projects', PROJECT, drawer, path);

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Start the powerpoint-deck book's own declared mocks, bound to a fresh trial project. */
async function startDeckMocks(): Promise<void> {
  const spec = craftbookEvalSpecMap().get('powerpoint-deck');
  expect(spec?.mocks?.length, 'powerpoint-deck ships mock services').toBeTruthy();
  home = await mkdtemp(join(tmpdir(), 'gezel-mock-reconcile-'));
  runtime = await startMockServices(spec!.mocks!, { trialHome: home });
  runtime!.bindProject(PROJECT);
  previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  client = new Client({ name: 'probe', version: '1.0.0' });
  const baseUrl = runtime!.services.get('docblocks')!.baseUrl;
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
}

type Json = Record<string, unknown>;

async function call(name: string, args: Json): Promise<Json> {
  const result = await client!.callTool({ name, arguments: args });
  const [first] = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(first!.text) as Json;
}

function firstArtifact(converted: Json): Json {
  return (converted.artifacts as Json[])[0]!;
}

function logged(tool: string) {
  return runtime!.services
    .get('docblocks')!
    .requests.filter((entry) => entry.path === `tools/call:${tool}`);
}

describe('powerpoint-deck mock responses agree with the trial', () => {
  for (const slides of [6, 8]) {
    it(`reports the real hash, size, and ${slides}-slide count of a ${slides}-slide source`, async () => {
      await startDeckMocks();
      await mkdir(dirname(drawerPath('workspace', DECK_MD)), { recursive: true });
      await writeFile(drawerPath('workspace', DECK_MD), deckOf(slides));

      const converted = await call('convert_document', {
        source: { kind: 'file', rootId: 'workspace', path: DECK_MD },
        targets: [{ format: 'pptx', fidelity: 'editable-native', slideBreak: 'h1' }],
      });
      const uri = firstArtifact(converted).uri as string;
      const previewed = await call('preview_document', { source: { kind: 'artifact', uri } });
      const saved = await call('save_artifact', {
        artifactUri: uri,
        destination: { path: SAVED },
      });
      // What copy_artifact_to_workspace does in the real run: same bytes, new path.
      await mkdir(dirname(drawerPath('workspace', DELIVERABLE)), { recursive: true });
      await copyFile(drawerPath('artifacts', SAVED), drawerPath('workspace', DELIVERABLE));
      const reopened = await call('preview_document', {
        source: { kind: 'file', rootId: 'artifacts', path: SAVED },
      });
      const delivered = await call('preview_document', {
        source: { kind: 'file', rootId: 'workspace', path: DELIVERABLE },
      });

      const onDisk = new Uint8Array(await readFile(drawerPath('artifacts', SAVED)));
      expect(readStoredZip(onDisk).has(`ppt/slides/slide${slides}.xml`)).toBe(true);
      expect(readStoredZip(onDisk).has(`ppt/slides/slide${slides + 1}.xml`)).toBe(false);

      // (a) the save reports the file it wrote — and the conversion reported the same file.
      expect(saved).toEqual({ ok: true, bytes: onDisk.length, sha256: sha256(onDisk) });
      expect(firstArtifact(converted)).toEqual({ format: 'pptx', uri, sha256: sha256(onDisk) });
      // (b) every preview of this deck reports its real slide count, shape unchanged.
      for (const preview of [previewed, reopened, delivered]) {
        expect(preview).toEqual({ slides, overflow: false, tinyText: false, previewed: true });
      }

      expect(logged('save_artifact')[0]?.reconciled).toEqual({
        bytes: { declared: 2400, actual: onDisk.length },
        sha256: { declared: '2'.repeat(64), actual: sha256(onDisk) },
      });
      expect(logged('convert_document')[0]?.reconciled).toEqual({
        'artifacts[0].sha256': { declared: '1'.repeat(64), actual: sha256(onDisk) },
      });
      for (const entry of logged('preview_document')) {
        expect(entry.reconciled).toEqual({ slides: { declared: 7, actual: slides } });
      }
    });
  }

  it('keeps the declared counts when no source is known, but never a false hash', async () => {
    await startDeckMocks();
    // A save with no conversion before it writes the fixed fixture.
    const saved = await call('save_artifact', {
      artifactUri: 'mock://docblocks/deck.pptx',
      destination: { path: SAVED },
    });
    const previewed = await call('preview_document', {
      source: { kind: 'file', rootId: 'artifacts', path: SAVED },
    });
    const unknownUri = await call('preview_document', {
      source: { kind: 'artifact', uri: 'mock://never-converted' },
    });
    // A deck this trial never wrote.
    await mkdir(dirname(drawerPath('workspace', 'source/other.pptx')), { recursive: true });
    await writeFile(drawerPath('workspace', 'source/other.pptx'), deckOf(3));
    const foreign = await call('preview_document', { source: 'source/other.pptx' });

    const fixture = minimalPptxFixture();
    expect(new Uint8Array(await readFile(drawerPath('artifacts', SAVED)))).toEqual(fixture);
    expect(saved).toEqual({ ok: true, bytes: fixture.length, sha256: sha256(fixture) });
    for (const preview of [previewed, unknownUri, foreign]) {
      expect(preview).toEqual({ slides: 7, overflow: false, tinyText: false, previewed: true });
    }
    for (const entry of logged('preview_document')) expect(entry.reconciled).toBeUndefined();
  });

  it('never mutates the declared template it serves from', async () => {
    await startDeckMocks();
    await mkdir(dirname(drawerPath('workspace', DECK_MD)), { recursive: true });
    await writeFile(drawerPath('workspace', DECK_MD), deckOf(6));
    const converted = await call('convert_document', {
      source: { kind: 'file', rootId: 'workspace', path: DECK_MD },
      targets: [{ format: 'pptx', slideBreak: 'h1' }],
    });
    await call('preview_document', {
      source: { kind: 'artifact', uri: firstArtifact(converted).uri as string },
    });

    const tools = craftbookEvalSpecMap().get('powerpoint-deck')!.mocks![0]!;
    const template = (name: string) =>
      tools.kind === 'mcp' ? tools.tools.find((tool) => tool.name === name)?.resultTemplate : null;
    expect(template('preview_document')).toMatchObject({ slides: 7 });
    expect(template('convert_document')).toMatchObject({
      artifacts: [{ sha256: '1'.repeat(64) }],
    });
  });
});

describe('reconcileMockResponse', () => {
  const context = { projectId: null };

  it('patches only mapped fields of the declared type, keeping the shape', async () => {
    const { response, reconciled } = await reconcileMockResponse(
      'save_artifact',
      { ok: true, bytes: '2400', sha256: 'abc', size: 9, extra: { sha256: 'nested' } },
      {
        args: {},
        conversion: null,
        materialized: { sha256: 'f'.repeat(64), bytes: 1234, slideCount: null },
        ledger: createMockDocumentLedger(),
        context,
      },
    );
    // `bytes` was declared as a string, `size` is not a mapped field, nested
    // values are never searched: only the top-level `sha256` changes.
    expect(response).toEqual({
      ok: true,
      bytes: '2400',
      sha256: 'f'.repeat(64),
      size: 9,
      extra: { sha256: 'nested' },
    });
    expect(reconciled).toEqual({ sha256: { declared: 'abc', actual: 'f'.repeat(64) } });
  });

  it('leaves tools outside the field map, and unknowable counts, as declared', async () => {
    const facts = {
      args: { source: { kind: 'artifact', uri: 'mock://report.docx' } },
      conversion: null,
      materialized: null,
      ledger: createMockDocumentLedger(),
      context,
    };
    const list = await reconcileMockResponse('list_roots', { roots: [], slides: 7 }, facts);
    expect(list).toEqual({ response: { roots: [], slides: 7 }, reconciled: null });
    // A DOCX preview's page count has no computed truth (research-to-document).
    facts.ledger.conversions.push({
      source: { markdown: '# Report\n', origin: 'workspace/report.md' },
      resultStrings: new Set(['mock://report.docx']),
      slideCount: null,
    });
    const docx = await reconcileMockResponse('preview_document', { pages: 4 }, facts);
    expect(docx).toEqual({ response: { pages: 4 }, reconciled: null });
  });
});
