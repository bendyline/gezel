/** Verify the shipped CLI really exposes conversion tools without a catalog installation. */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { expect, it } from 'vitest';
import { convertInSandbox } from '../index-store/sandbox-convert.js';
import { McpBridge } from '../providers/mcp-bridge.js';
import { bundledDocblocksToolset } from './bundled-docblocks.js';

it('starts the included MCP runtime and lists its document formats', async () => {
  const toolset = bundledDocblocksToolset();
  const bridge = new McpBridge();
  try {
    await bridge.start({
      command: process.execPath,
      args: [join(toolset.installPath!, 'dist/bin.js'), 'mcp'],
      env: {},
    });
    const result = await bridge.callToolRich('list_formats', {});
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain('pptx');
    expect(result.text).toContain('mp4');
  } finally {
    await bridge.stop();
  }
}, 30_000);

const LIST_DECK = [
  '# Onboarding a new client',
  '',
  'How we bring a client on in four weeks.',
  '',
  '# How onboarding works',
  '',
  '1. Kickoff call with the account lead',
  '2. Data import from the old system',
  '3. Training for the client team',
  '4. Go-live review',
  '',
  '# What we measure',
  '',
  '- Time to first invoice: days from signing to the first bill',
  '- Adoption: share of client staff who log in weekly',
  '- Support load: tickets in the first month',
  '',
].join('\n');

/**
 * From 2.7.16 a slide whose body is one short list is drawn as a picture of
 * how its items relate (steps, cards) instead of bullets, and
 * `recommend_templates` reports that reading as `profile.listShape`. Two
 * things Gezel depends on: the new output field passes the bridge's
 * schema-validating client, and the drawn slides still read back through
 * `read_doc_as_markdown`'s converter with every item in order, since
 * reviewers and gates read decks that way.
 */
it('draws short lists as pictures that Gezel still reads back', async () => {
  const toolset = bundledDocblocksToolset();
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'gezel-docblocks-lists-')));
  const bridge = new McpBridge();
  try {
    await bridge.start({
      command: process.execPath,
      args: [join(toolset.installPath!, 'dist/bin.js'), 'mcp', '--allow-write', dir],
      env: {},
    });
    const callText = async (name: string, args: Record<string, unknown>) => {
      const result = await bridge.callToolRich(name, args);
      expect(result.isError, `${name}: ${result.text}`).toBeFalsy();
      return result.text;
    };
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(await callText(name, args)) as Record<string, unknown>;
    const source = { kind: 'markdown', markdown: LIST_DECK };

    const { recommendations } = (await call('recommend_templates', { source })) as {
      recommendations: Array<{ title: string; profile: { listShape: unknown } }>;
    };
    expect(recommendations.map((block) => [block.title, block.profile.listShape])).toEqual([
      ['Onboarding a new client', null],
      ['How onboarding works', expect.objectContaining({ shape: 'sequence' })],
      ['What we measure', expect.objectContaining({ shape: 'parallel' })],
    ]);
    // A gezel reads this tool's prose, not its structured result.
    expect(await callText('get_authoring_context', { targetFormat: 'pptx', source })).toMatch(
      /drawn as a picture/,
    );

    const { roots } = (await call('list_roots', {})) as {
      roots: Array<{ id: string; write: boolean }>;
    };
    const rootId = roots.find((root) => root.write)?.id;
    expect(rootId).toBeDefined();
    const { results } = (await call('convert_document', {
      source,
      targets: [{ format: 'pptx', slideBreak: 'h1', fidelity: 'editable-native' }],
    })) as { results: Array<{ artifact: { uri: string } }> };
    await call('save_artifact', {
      artifactUri: results[0]!.artifact.uri,
      destination: { rootId, path: 'deck.pptx', ifExists: 'error' },
    });

    const deckPath = join(dir, 'deck.pptx');
    const slides = new AdmZip(deckPath);
    for (const slide of ['ppt/slides/slide2.xml', 'ppt/slides/slide3.xml']) {
      const xml = slides.readAsText(slide);
      expect(xml, `${slide} should be drawn, not bulleted`).not.toMatch(/<a:bu(?:AutoNum|Char)\b/);
    }

    const { markdown } = await convertInSandbox(deckPath, 'pptx');
    expect(markdown).not.toBeNull();
    const items = [
      'Kickoff call with the account lead',
      'Data import from the old system',
      'Training for the client team',
      'Go-live review',
      'Time to first invoice',
      'days from signing to the first bill',
      'Adoption',
      'share of client staff who log in weekly',
      'Support load',
      'tickets in the first month',
    ];
    const positions = items.map((item) => markdown?.indexOf(item) ?? -1);
    expect(
      positions.filter((at) => at < 0),
      markdown ?? '',
    ).toEqual([]);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  } finally {
    await bridge.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
