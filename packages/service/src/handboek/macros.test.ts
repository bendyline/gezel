import { poppetjeFromSeed, seedFromKey } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { HandboekDeviceInfo, HandboekGezelInfo } from './device.js';
import { siteDeviceInfo } from './device.js';
import { type HandboekCatalog, expandMacros, parseAttrs } from './macros.js';

function gezel(id: string, name: string, role: string): HandboekGezelInfo {
  return { id, name, role, poppetje: poppetjeFromSeed(seedFromKey(id)) };
}

function stubDevice(gezels: HandboekGezelInfo[], meesterId?: string): HandboekDeviceInfo {
  return {
    listGezels: async () => gezels,
    meesterGezelId: async () => meesterId ?? null,
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
}

const stubCatalog: HandboekCatalog = {
  async list(kind) {
    if (kind === 'craftbook-template') {
      return [
        {
          sourceId: 'test',
          kind,
          manifest: {
            id: 'research-report',
            name: 'Research Report',
            description: 'Investigate a question thoroughly. Then write it up.',
          } as never,
        },
      ];
    }
    return [];
  },
  async get(kind, id) {
    if (kind === 'craftbook-template' && id === 'research-report') {
      return {
        sourceId: 'test',
        kind,
        manifest: {
          id: 'research-report',
          name: 'Research Report',
          description: 'Investigate a question thoroughly.',
          steps: [
            {
              id: 'plan',
              name: 'Scope the question',
              suggestedRole: 'planner',
              description: 'Define what good looks like.',
            },
            { id: 'research', name: 'Gather sources', suggestedRole: 'researcher' },
          ],
          triggers: ['write a research report'],
          toolsets: [{ toolsetId: 'web' }],
        } as never,
      };
    }
    if (kind === 'gezel-template' && id === 'meester') {
      return {
        sourceId: 'test',
        kind,
        manifest: { id: 'meester', role: 'Meester' } as never,
        about: '## Identity\n\nYou are the guildmaster.',
      };
    }
    return null;
  },
};

function ctx(mode: 'app' | 'site' | 'agent', device: HandboekDeviceInfo = stubDevice([])) {
  return { mode, catalog: stubCatalog, device } as const;
}

describe('parseAttrs', () => {
  it('parses bare and quoted attribute values', () => {
    expect(parseAttrs('role=meester scope="device wide" empty=""')).toEqual({
      role: 'meester',
      scope: 'device wide',
      empty: '',
    });
  });
});

describe('gezel-roster macro', () => {
  const alice = gezel('g1', 'Alice', 'Meester');
  const jack = gezel('g2', 'Jack', 'Meester');
  const device = stubDevice([alice, jack, gezel('g3', 'Iris', 'Researcher')], 'g1');

  it('app mode: names the matching gezels and emits their figures', async () => {
    const { markdown, figures } = await expandMacros('::handboek-gezel-roster{role=meester}', {
      ...ctx('app', device),
    });
    expect(markdown).toContain('You have two meester gezellen: **Alice** and **Jack**.');
    expect(markdown).toContain('![Alice](poppetje/g1.headshot.svg)');
    expect(figures).toHaveLength(2);
    expect(figures[0]).toMatchObject({
      gezelId: 'g1',
      variant: 'headshot',
      path: 'poppetje/g1.headshot.svg',
    });
  });

  it('site mode: renders nothing personal', async () => {
    const { markdown, figures } = await expandMacros('before\n::handboek-gezel-roster\nafter', {
      ...ctx('site', device),
    });
    // The surviving lines fold into one paragraph — see unwrap.ts.
    expect(markdown).toBe('before after');
    expect(figures).toHaveLength(0);
  });

  it('agent mode: sentence without figures', async () => {
    const { markdown, figures } = await expandMacros('::handboek-gezel-roster{role=researcher}', {
      ...ctx('agent', device),
    });
    expect(markdown).toContain('one researcher gezel: **Iris**');
    expect(figures).toHaveLength(0);
  });

  it('reads naturally without a role filter', async () => {
    const { markdown } = await expandMacros('::handboek-gezel-roster', { ...ctx('agent', device) });
    expect(markdown).toContain('You have three gezellen:');
    expect(markdown).not.toContain('gezel gezellen');
  });

  it('suggests the Meester when the role has no gezels yet', async () => {
    const { markdown } = await expandMacros('::handboek-gezel-roster{role=reviewer}', {
      ...ctx('app', device),
    });
    expect(markdown).toContain("don't have a reviewer gezel yet");
  });
});

describe('meester-card macro', () => {
  it('app mode names the current meester', async () => {
    const device = stubDevice([gezel('g1', 'Alice', 'Meester')], 'g1');
    const { markdown, figures } = await expandMacros('::handboek-meester-card', {
      ...ctx('app', device),
    });
    expect(markdown).toContain('Your Meester is **Alice**.');
    expect(figures).toHaveLength(1);
  });

  it('site mode stays generic', async () => {
    const { markdown } = await expandMacros('::handboek-meester-card', { ...ctx('site') });
    expect(markdown).toContain('guildmaster');
    expect(markdown).not.toContain('Alice');
  });
});

describe('data macros', () => {
  it('role-summary-table lists every built-in role with article links', async () => {
    const { markdown } = await expandMacros('::handboek-role-summary-table', { ...ctx('site') });
    expect(markdown).toContain('| [Meester](role/meester) |');
    expect(markdown).toContain('| [Voorman](role/voorman) |');
    expect(markdown).toContain('| Model floor |');
  });

  it('role-tools renders the default kit as a table', async () => {
    const { markdown } = await expandMacros('::handboek-role-tools{role=meester scope=default}', {
      ...ctx('site'),
    });
    expect(markdown).toContain('| Tool group | Purpose | Tools |');
    expect(markdown).toContain('Team');
    expect(markdown).toContain('`create_gezel`');
  });

  it('role-tools scope=device tailors to installed models in app mode', async () => {
    const { markdown } = await expandMacros('::handboek-role-tools{role=developer scope=device}', {
      ...ctx('app'),
    });
    expect(markdown).toContain('On this device:');
    expect(markdown).toContain('| Qwen 27B | medium |');
    expect(markdown).toContain('cloud provider');
  });

  it('role-tools scope=device explains itself with no local models', async () => {
    const { markdown } = await expandMacros('::handboek-role-tools{role=developer scope=device}', {
      mode: 'app',
      catalog: stubCatalog,
      device: { ...stubDevice([]), listInstalledModels: async () => [] },
    });
    expect(markdown).toContain('No local models are installed');
  });

  it('role-tools scope=tiers renders one row per tier', async () => {
    const { markdown } = await expandMacros('::handboek-role-tools{role=developer scope=tiers}', {
      ...ctx('site'),
    });
    for (const tier of ['tiny', 'small', 'medium', 'large', 'cloud']) {
      expect(markdown).toContain(`| ${tier} |`);
    }
    expect(markdown).toContain('full kit');
  });

  it('role-about pulls the template about.md and demotes headings', async () => {
    const { markdown } = await expandMacros('::handboek-role-about{role=meester}', {
      ...ctx('site'),
    });
    expect(markdown).toContain('### Identity');
    expect(markdown).toContain('guildmaster');
  });

  it('craftbook-steps renders the step table with role labels and triggers', async () => {
    const { markdown } = await expandMacros('::handboek-craftbook-steps{id=research-report}', {
      ...ctx('site'),
    });
    expect(markdown).toContain('| 1 | Scope the question | Planner |');
    expect(markdown).toContain('| 2 | Gather sources | Researcher |');
    expect(markdown).toContain('"write a research report"');
    expect(markdown).toContain('`web`');
  });

  it('craftbook-list tabulates the catalog with article links', async () => {
    const { markdown } = await expandMacros('::handboek-craftbook-list', { ...ctx('site') });
    expect(markdown).toContain(
      '| [Research Report](craftbook/research-report) | Investigate a question thoroughly. |',
    );
  });

  it('installed-models is personalized in app mode and generic on the site', async () => {
    const app = await expandMacros('::handboek-installed-models', { ...ctx('app') });
    expect(app.markdown).toContain('| Qwen 27B | llama-cpp | 27B | medium |');
    const site = await expandMacros('::handboek-installed-models', { ...ctx('site') });
    expect(site.markdown).not.toContain('Qwen');
  });

  it('device-hardware describes the current hardware and capacity tier', async () => {
    const app = await expandMacros('::handboek-device-hardware', { ...ctx('app') });
    expect(app.markdown).toContain('Apple Silicon unified memory: 64.0 GB total');
    expect(app.markdown).toContain('| **large** |');
    const site = await expandMacros('::handboek-device-hardware', { ...ctx('site') });
    expect(site.markdown).not.toContain('64.0 GB');
    expect(site.markdown).toContain('Open this page in the app');
  });
});

describe('expansion mechanics', () => {
  it('leaves unknown macros in place for the lint test to catch', async () => {
    const { markdown } = await expandMacros('::handboek-does-not-exist{x=1}', { ...ctx('app') });
    expect(markdown).toBe('::handboek-does-not-exist{x=1}');
  });

  it('does not touch directive-like text that is not line-anchored', async () => {
    const source = 'Use `::handboek-gezel-roster` in an article.';
    const { markdown } = await expandMacros(source, { ...ctx('app') });
    expect(markdown).toBe(source);
  });

  it('a macro that throws renders nothing instead of failing the article', async () => {
    const throwingDevice: HandboekDeviceInfo = {
      ...siteDeviceInfo,
      listGezels: async () => {
        throw new Error('store offline');
      },
    };
    const { markdown } = await expandMacros('a\n::handboek-gezel-roster\nb', {
      mode: 'app',
      catalog: stubCatalog,
      device: throwingDevice,
    });
    expect(markdown).toBe('a b');
  });
});
