import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { craftbookEvalSpecMap } from '../craftbooks/specs.ts';
import { readStoredZip } from '../fixtures/office-documents.ts';
import {
  type MockConversionRecord,
  conversionSourceForSave,
  recordMockConversion,
} from './conversion-source.ts';
import { type MockServicesRuntime, startMockServices } from './mock-server.ts';

const PROJECT = 'pptx-eval';
let home: string | undefined;
let runtime: MockServicesRuntime | null = null;

afterEach(async () => {
  await runtime?.close();
  runtime = null;
  if (home) await rm(home, { recursive: true, force: true });
  home = undefined;
});

async function seed(drawer: 'workspace' | 'artifacts', path: string, content: string) {
  const target = join(home!, 'projects', PROJECT, drawer, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
  return target;
}

const served = (uri: string) => ({ artifacts: [{ format: 'pptx', uri }], diagnostics: [] });

describe('recordMockConversion', () => {
  it('snapshots the workspace Markdown at conversion time, with the requested slide break', async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-mock-source-'));
    const deck = await seed('workspace', 'powerpoint/eval/deck.md', '# Approved\n- fact\n');
    const record = await recordMockConversion(
      {
        source: { kind: 'file', rootId: 'workspace', path: 'powerpoint/eval/deck.md' },
        targets: [{ format: 'pptx', fidelity: 'editable-native', slideBreak: 'h1' }],
      },
      served('mock://docblocks/deck.pptx'),
      { trialHome: home, projectId: PROJECT },
      [],
    );
    // A rewrite after the conversion must not leak into what was converted.
    await writeFile(deck, '# Rewritten later\n');
    expect(record.source).toEqual({
      markdown: '# Approved\n- fact\n',
      origin: 'workspace/powerpoint/eval/deck.md',
      slideBreak: 'h1',
    });
    expect(record.resultStrings.has('mock://docblocks/deck.pptx')).toBe(true);
  });

  it('resolves every source shape DocBlocks accepts', async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-mock-source-'));
    await seed('workspace', 'notes/plain.md', '# Plain string source\n');
    await seed('artifacts', 'tasks/1/draft.md', '# Artifact drawer\n');
    const context = { trialHome: home, projectId: PROJECT };
    const record = (args: unknown, earlier: MockConversionRecord[] = []) =>
      recordMockConversion(args, served('mock://x'), context, earlier);

    expect((await record({ source: 'notes/plain.md' })).source?.origin).toBe(
      'workspace/notes/plain.md',
    );
    expect(
      (await record({ source: { kind: 'file', rootId: 'artifacts', path: 'tasks/1/draft.md' } }))
        .source?.origin,
    ).toBe('artifacts/tasks/1/draft.md');
    // A placeholder root id still finds the file rather than silently falling back.
    expect(
      (
        await record({
          source: { kind: 'file', rootId: 'ARTIFACTS_ROOT_ID', path: 'tasks/1/draft.md' },
        })
      ).source?.origin,
    ).toBe('artifacts/tasks/1/draft.md');
    // …but a real root id is honored: the workspace does not have that file.
    expect(
      (await record({ source: { kind: 'file', rootId: 'workspace', path: 'tasks/1/draft.md' } }))
        .source,
    ).toBeNull();
    expect((await record({ source: { kind: 'markdown', markdown: '# Inline\n' } })).source).toEqual(
      { markdown: '# Inline\n', origin: 'inline markdown' },
    );

    const first = await record({ source: 'notes/plain.md' });
    expect(
      (await record({ source: { kind: 'artifact', uri: 'mock://x' } }, [first])).source?.origin,
    ).toBe('workspace/notes/plain.md');
  });

  it('refuses sources it cannot honestly convert, or that escape the project', async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-mock-source-'));
    await seed('workspace', 'source/brief.docx', 'PK not markdown');
    const outside = join(home, 'outside.md');
    await writeFile(outside, '# Outside the project\n');
    await mkdir(join(home, 'projects', PROJECT, 'workspace'), { recursive: true });
    await symlink(outside, join(home, 'projects', PROJECT, 'workspace', 'link.md'));
    await mkdir(join(home, 'projects', 'other', 'workspace'), { recursive: true });
    await writeFile(join(home, 'projects', 'other', 'workspace', 'deck.md'), '# Other\n');
    const context = { trialHome: home, projectId: PROJECT };

    for (const source of [
      'source/brief.docx',
      '../other/workspace/deck.md',
      '../../other/workspace/deck.md',
      'link.md',
      'missing.md',
      { kind: 'artifact', uri: 'mock://never-returned' },
      { kind: 'file' },
    ]) {
      const record = await recordMockConversion({ source }, {}, context, []);
      expect(record.source, JSON.stringify(source)).toBeNull();
    }
    // No bound project: nothing on disk to read.
    expect(
      (await recordMockConversion({ source: 'deck.md' }, {}, { projectId: null }, [])).source,
    ).toBeNull();
  });
});

describe('conversionSourceForSave', () => {
  const record = (origin: string, uri: string): MockConversionRecord => ({
    source: { markdown: `# ${origin}\n`, origin },
    resultStrings: new Set([uri]),
    slideCount: null,
  });

  it('follows the artifact URI the save cites, else the latest conversion', () => {
    const conversions = [record('deck', 'mock://deck.pptx'), record('report', 'mock://r.docx')];
    expect(conversionSourceForSave({ artifactUri: 'mock://deck.pptx' }, conversions)?.origin).toBe(
      'deck',
    );
    expect(conversionSourceForSave({ artifactUri: 'mock://unknown' }, conversions)?.origin).toBe(
      'report',
    );
    expect(conversionSourceForSave({ destination: { path: 'x' } }, conversions)?.origin).toBe(
      'report',
    );
    expect(conversionSourceForSave({}, [])).toBeNull();
  });

  it('does not reach past the latest conversion to an older readable one', () => {
    // Canned URIs repeat: the most recent conversion is what the URI names now,
    // even when its source (a DOCX) could not be read as Markdown.
    const conversions = [
      record('deck', 'mock://deck.pptx'),
      { source: null, resultStrings: new Set(['mock://deck.pptx']), slideCount: null },
    ];
    expect(conversionSourceForSave({ artifactUri: 'mock://deck.pptx' }, conversions)).toBeNull();
  });
});

describe('powerpoint-deck mock, end to end', () => {
  it('saves the deck the conversion was asked to convert, and logs where it came from', async () => {
    const spec = craftbookEvalSpecMap().get('powerpoint-deck');
    expect(spec?.mocks?.length, 'powerpoint-deck ships mock services').toBeTruthy();
    home = await mkdtemp(join(tmpdir(), 'gezel-mock-e2e-'));
    runtime = await startMockServices(spec!.mocks!, { trialHome: home });
    runtime!.bindProject(PROJECT);
    await seed(
      'workspace',
      'powerpoint/eval/deck.md',
      '# Boreal Desk Returns Pilot\n- Pilot coverage: **18 SKUs**\n\n# Next Actions\n- Automated status emails\n',
    );

    const service = runtime!.services.get('docblocks')!;
    const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const client = new Client({ name: 'probe', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${service.baseUrl}/mcp`)));
      const converted = await client.callTool({
        name: 'convert_document',
        arguments: {
          source: { kind: 'file', rootId: 'workspace', path: 'powerpoint/eval/deck.md' },
          targets: [{ format: 'pptx', fidelity: 'editable-native', slideBreak: 'h1' }],
        },
      });
      const [first] = converted.content as Array<{ type: string; text: string }>;
      const uri = (JSON.parse(first!.text) as { artifacts: Array<{ uri: string }> }).artifacts[0]
        ?.uri;
      expect(uri).toBeTruthy();
      await client.callTool({
        name: 'save_artifact',
        arguments: { artifactUri: uri, destination: { path: 'tasks/1/deck.pptx' } },
      });
      await client.close();
    } finally {
      if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
    }

    const saved = await readFile(join(home, 'projects', PROJECT, 'artifacts', 'tasks/1/deck.pptx'));
    expect(saved.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(saved.includes(Buffer.from('Deterministic DocBlocks eval deck'))).toBe(false);
    const entries = readStoredZip(saved);
    expect(entries.get('ppt/slides/slide1.xml')).toContain('<a:t>Boreal Desk Returns Pilot</a:t>');
    expect(entries.get('ppt/slides/slide1.xml')).toContain('<a:t>Pilot coverage: 18 SKUs</a:t>');
    expect(entries.get('ppt/slides/slide2.xml')).toContain('<a:t>Next Actions</a:t>');
    expect(entries.has('ppt/slides/slide3.xml')).toBe(false);

    const save = service.requests.find((entry) => entry.path === 'tools/call:save_artifact');
    expect(save?.materializedFrom).toBe('workspace/powerpoint/eval/deck.md');
  });
});
