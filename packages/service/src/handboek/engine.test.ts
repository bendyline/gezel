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
  });

  it('serves a curated article with personalization in app mode', async () => {
    const article = await makeEngine().article('the-crew', { mode: 'app' });
    expect(article).toBeTruthy();
    expect(article!.markdown).toContain('Your Meester is **Alice**.');
    expect(article!.figures.length).toBeGreaterThan(0);
    expect(article!.generated).toBe(false);
  });

  it('serves generated craftbook and project-type articles', async () => {
    const engine = makeEngine();
    const book = await engine.article('craftbook/status-report', { mode: 'site' });
    expect(book!.title).toBe('Status Report');
    expect(book!.markdown).toContain('| 1 | Collect | Voorman |');
    const pt = await engine.article('project-type/web-shop', { mode: 'site' });
    expect(pt!.markdown).toContain('web-developer');
    expect(pt!.markdown).toContain('`0 9 * * 1`');
  });

  it('returns null for unknown ids', async () => {
    expect(await makeEngine().article('no-such-article')).toBeNull();
  });
});

describe('no surviving directives (content lint)', () => {
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
});
