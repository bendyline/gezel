import type { HandboekRenderMode } from '@bendyline/gezel';
import { poppetjeFromSeed, seedFromKey } from '@bendyline/gezel';
import { parseMarkdown, walkMarkdownTree } from '@bendyline/squisq/markdown';
import { describe, expect, it } from 'vitest';
import type { HandboekDeviceInfo } from './device.js';
import { type HandboekCatalog, createHandboekEngine, findHandboekContent } from './engine.js';

const device: HandboekDeviceInfo = {
  listGezels: async () => [
    { id: 'g1', name: 'Alice', role: 'Meester', poppetje: poppetjeFromSeed(seedFromKey('g1')) },
    { id: 'g2', name: 'Iris', role: 'Researcher', poppetje: poppetjeFromSeed(seedFromKey('g2')) },
  ],
  meesterGezelId: async () => 'g1',
  listInstalledModels: async () => [
    {
      id: 'qwen-27b',
      name: 'Qwen 27B',
      provider: 'llama-cpp',
      parameterSize: '27B',
      tier: 'medium',
    },
  ],
  currentHardware: async () => ({
    description:
      'Apple Silicon unified memory: 64.0 GB total, with about 38.4 GB available for local models.',
    tier: 'large',
  }),
};

const catalog: HandboekCatalog = {
  async list(kind) {
    if (kind === 'craftbook-template') {
      return [
        {
          sourceId: 'test',
          kind,
          manifest: {
            id: 'status-report',
            name: 'Status Report',
            description: 'Summarize the week. Keep it honest.',
            tags: ['status', 'report', 'weekly'],
          } as never,
        },
      ];
    }
    if (kind === 'project-type') {
      return [
        {
          sourceId: 'test',
          kind,
          manifest: {
            id: 'web-shop',
            name: 'Web Shop',
            description: 'Run a small storefront. Everything included.',
          } as never,
        },
      ];
    }
    return [];
  },
  async get(kind, id) {
    if (kind === 'craftbook-template' && id === 'status-report') {
      return {
        sourceId: 'test',
        kind,
        manifest: {
          id: 'status-report',
          name: 'Status Report',
          description: 'Summarize the week.',
          steps: [{ id: 's1', name: 'Collect', suggestedRole: 'voorman' }],
          triggers: ['status report'],
        } as never,
      };
    }
    if (kind === 'project-type' && id === 'web-shop') {
      return {
        sourceId: 'test',
        kind,
        manifest: {
          id: 'web-shop',
          name: 'Web Shop',
          description: 'Run a small storefront.',
          gezels: [{ templateId: 'web-developer', voorman: true }],
          toolsets: [{ id: 'web' }],
          craftbooks: ['status-report'],
          schedules: [{ cron: '0 9 * * 1', craftbook: 'status-report', consent: 'ask' }],
        } as never,
      };
    }
    if (kind === 'gezel-template') {
      return {
        sourceId: 'test',
        kind,
        manifest: { id, role: id } as never,
        about: `## Identity\n\nDefault ${id} character.`,
      };
    }
    return null;
  },
};

function makeEngine() {
  const contentDir = findHandboekContent();
  expect(contentDir).toBeTruthy();
  return createHandboekEngine({ catalog, device, contentDir: contentDir! });
}

describe('handboek engine', () => {
  it('builds a TOC with every area, curated shadowing generated', async () => {
    const toc = await makeEngine().toc();
    const areas = toc.areas.map((a) => a.area);
    expect(areas).toEqual([
      'conceptual',
      'gezel-roles',
      'craftbooks',
      'project-types',
      'technical',
      'whats-new',
    ]);
    const conceptual = toc.areas[0]!;
    expect(conceptual.entries[0]).toMatchObject({ id: 'welcome', generated: false });
    const roles = toc.areas.find((a) => a.area === 'gezel-roles')!;
    const meesterEntries = roles.entries.filter((e) => e.id === 'role/meester');
    expect(meesterEntries).toHaveLength(1);
    expect(meesterEntries[0]).toMatchObject({ generated: false, title: 'The Meester' });
    // Every built-in role has a curated lead, and curated always shadows
    // the generated fallback — exactly one entry per role.
    const roleEntries = roles.entries.filter((e) => e.id.startsWith('role/'));
    expect(roleEntries).toHaveLength(11);
    expect(roleEntries.every((e) => !e.generated)).toBe(true);
    const craftbooks = toc.areas.find((a) => a.area === 'craftbooks')!;
    expect(craftbooks.entries.map((e) => e.id)).toEqual([
      'craftbooks-index',
      'craftbook/status-report',
    ]);
    // Shelved by subject, with the family named because the list is flat.
    expect(craftbooks.entries[1]?.subcategory).toEqual({
      id: 'business',
      title: 'Business · Money & admin',
      order: 12,
    });
    const technical = toc.areas.find((a) => a.area === 'technical')!;
    expect(technical.entries.map((entry) => [entry.id, entry.subcategory?.title])).toEqual([
      ['architecture', 'How Gezel works'],
      ['where-files-live', 'How Gezel works'],
      ['providers-and-engines', 'How Gezel works'],
      ['tools-and-toolsets', 'How Gezel works'],
      ['security-model', 'How Gezel works'],
      ['verifying-your-download', 'How Gezel works'],
      ['cli-reference', 'The Gezel Command Line'],
      ['npm-packages', 'The Gezel Command Line'],
      ['writing-scripts-with-gezel-sdk', 'Developer'],
      ['building-connected-apps-with-gezel-app-sdk', 'Developer'],
      ['building-ai-apps-inside-gezel', 'Developer'],
      ['how-we-test-models', 'Models and Testing'],
      ['model-scorecard', 'Models and Testing'],
    ]);
  });

  it('serves a curated article with personalization in app mode', async () => {
    const article = await makeEngine().article('the-crew', { mode: 'app' });
    expect(article).toBeTruthy();
    expect(article!.markdown).toContain('Your Meester is **Alice**.');
    expect(article!.figures.length).toBeGreaterThan(0);
    expect(article!.generated).toBe(false);
  });

  it('links catalog discovery articles to the public Gezel Gilde', async () => {
    const engine = makeEngine();
    for (const [articleId, url] of [
      ['craftbooks-overview', 'https://gezelgilde.com/craftbooks/'],
      ['local-models-and-tiers', 'https://gezelgilde.com/models/'],
      ['roles-index', 'https://gezelgilde.com/roles/'],
      ['tools-and-toolsets', 'https://gezelgilde.com/toolsets/'],
      ['tools-and-toolsets', 'https://gezelgilde.com/community/'],
      ['building-ai-apps-inside-gezel', 'https://gezelgilde.com/toolsets/#project-types'],
      ['building-ai-apps-inside-gezel', 'https://gezelgilde.com/craftbooks/'],
      ['building-ai-apps-inside-gezel', 'https://gezelgilde.com/roles/'],
      ['building-ai-apps-inside-gezel', 'https://gezelgilde.com/models/'],
    ] as const) {
      const article = await engine.article(articleId, { mode: 'site' });
      expect(article!.markdown).toContain(url);
    }
  });

  it('serves generated craftbook and project-type articles', async () => {
    const engine = makeEngine();
    const bookIndex = await engine.article('craftbooks-index', { mode: 'site' });
    expect(bookIndex!.markdown).toContain('https://gezelgilde.com/craftbooks/');
    const book = await engine.article('craftbook/status-report', { mode: 'site' });
    expect(book!.title).toBe('Status Report');
    expect(book!.markdown).toContain('| 1 | Collect | Voorman |');
    const ptIndex = await engine.article('project-types-index', { mode: 'site' });
    expect(ptIndex!.markdown).toContain('https://gezelgilde.com/toolsets/#project-types');
    const pt = await engine.article('project-type/web-shop', { mode: 'site' });
    expect(pt!.markdown).toContain('web-developer');
    expect(pt!.markdown).toContain('`0 9 * * 1`');
  });

  it('returns null for unknown ids', async () => {
    expect(await makeEngine().article('no-such-article')).toBeNull();
  });

  it("fills the what's-new index from the shipped release articles", async () => {
    const engine = makeEngine();
    const toc = await engine.toc();
    const releases = toc.areas
      .find((a) => a.area === 'whats-new')!
      .entries.filter((e) => e.id !== 'whats-new-index');
    expect(releases.length).toBeGreaterThan(0);
    // The list is generated, so a broken wiring shows up as an index with
    // no releases in it rather than as a failure anywhere near the macro.
    const index = await engine.article('whats-new-index', { mode: 'app' });
    for (const release of releases) {
      expect(index!.markdown).toContain(`[${release.title}](${release.id})`);
      expect(index!.markdown).toContain(release.summary!);
    }
  });
});

// These exhaustive corpus lints render every article in every mode. Their
// runtime grows with authored content and slows under full-suite IO contention.
describe('no surviving directives (content lint)', { timeout: 15_000 }, () => {
  it('every article in every mode expands cleanly', async () => {
    const engine = makeEngine();
    const toc = await engine.toc();
    const ids = toc.areas.flatMap((a) => a.entries.map((e) => e.id));
    expect(ids.length).toBeGreaterThan(10);
    const modes: HandboekRenderMode[] = ['app', 'site', 'agent'];
    const offenders: string[] = [];
    for (const id of ids) {
      for (const mode of modes) {
        const article = await engine.article(id, { mode });
        expect(article, `article ${id} (${mode})`).toBeTruthy();
        const doc = parseMarkdown(article!.markdown);
        walkMarkdownTree(doc as never, (node) => {
          const n = node as { type: string; name?: string };
          if (
            (n.type === 'leafDirective' || n.type === 'containerDirective') &&
            n.name?.startsWith('handboek-')
          ) {
            offenders.push(`${id} (${mode}): ::${n.name}`);
          }
        });
      }
    }
    expect(offenders, `unexpanded handboek macros:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('no article renders with a hard-wrapped paragraph', async () => {
    // squisq keeps a single newline inside a paragraph as literal text and
    // the doc renderer honors it, so source wrapped at 80 columns shows a
    // visible break after every line. See unwrap.ts.
    const engine = makeEngine();
    const toc = await engine.toc();
    const ids = toc.areas.flatMap((a) => a.entries.map((e) => e.id));
    const offenders: string[] = [];
    for (const id of ids) {
      for (const mode of ['app', 'site', 'agent'] as HandboekRenderMode[]) {
        const article = await engine.article(id, { mode });
        walkMarkdownTree(parseMarkdown(article!.markdown) as never, (node) => {
          const n = node as { type: string; value?: string };
          if (n.type === 'text' && n.value?.includes('\n')) {
            offenders.push(`${id} (${mode}): ${n.value.split('\n')[0]}…`);
          }
        });
      }
    }
    expect(offenders, `hard-wrapped paragraphs:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('every release note carries a tweet-sized summary', async () => {
    // The summary is the whole of a release in the what's-new list and in
    // the TOC — an author who leaves it off, or writes a paragraph into
    // it, breaks the one screen the section exists to provide.
    const releases = (await makeEngine().toc()).areas
      .find((a) => a.area === 'whats-new')!
      .entries.filter((e) => e.id !== 'whats-new-index');
    const offenders = releases
      .filter((e) => !e.summary || e.summary.length > 200)
      .map((e) => `${e.id}: ${e.summary ? `${e.summary.length} chars` : 'no summary'}`);
    expect(offenders, `release summaries:\n${offenders.join('\n')}`).toEqual([]);
  });
});
