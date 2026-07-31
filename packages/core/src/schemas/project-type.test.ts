import { describe, expect, it } from 'vitest';
import {
  CatalogItemManifestSchema,
  ProjectTypeManifestSchema,
  ProjectTypeVersionManifestSchema,
} from './catalog.js';
import { ProjectTypeCategorySchema } from './catalog.js';
import { ScriptRunTriggerSchema } from './script.js';

describe('ProjectType manifest schema', () => {
  it('accepts a minimal version manifest and fills array defaults', () => {
    const parsed = ProjectTypeVersionManifestSchema.parse({
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-07-06T00:00:00Z',
      extends: 'email',
      aboutTemplate: 'about.md',
    });
    // Composition arrays default to empty so a bare manifest is valid.
    expect(parsed.gezels).toEqual([]);
    expect(parsed.toolsets).toEqual([]);
    expect(parsed.craftbooks).toEqual([]);
    expect(parsed.tools).toEqual([]);
    expect(parsed.schedules).toEqual([]);
    expect(parsed.workspaceSeed).toEqual([]);
    expect(parsed.scripts).toBeUndefined();
    expect(parsed.pages).toBeUndefined();
    expect(parsed.meesterManaged).toBeUndefined();
    expect(parsed.indexingEnabled).toBeUndefined();
    expect(parsed.tabVisibility).toBeUndefined();
  });

  it('round-trips a full composition payload', () => {
    const full = {
      schemaVersion: 1 as const,
      version: '2.1.0',
      releasedAt: '2026-07-06T00:00:00Z',
      extends: 'content-writing',
      meesterManaged: false,
      indexingEnabled: false,
      tabVisibility: { overview: false, tasks: false, artifacts: true },
      params: { type: 'object', properties: { language: { type: 'string' } } },
      nameTemplate: '{{language}} Language Trainer',
      aboutTemplate: 'about.md',
      missionTemplate: 'mission.md',
      gezels: [{ templateId: 'language-trainer', voorman: true }],
      toolsets: [{ id: 'web-search', need: 'suggested' as const, autoAllow: ['search'] }],
      craftbooks: ['daily-lesson', 'weekly-review'],
      scripts: { 'progress-store': 'export const meta = { name: "progress-store" };\n' },
      tools: [
        {
          name: 'advance_level',
          description: 'Advance the learner to the next level.',
          script: 'progress-store',
          inputs: { type: 'object' },
        },
      ],
      pages: { entry: 'dashboard/index.html' },
      schedules: [{ cron: '0 18 * * *', craftbook: 'daily-lesson', consent: 'ask' as const }],
      workspaceSeed: ['progress.json'],
    };
    const parsed = ProjectTypeVersionManifestSchema.parse(full);
    expect(parsed.gezels[0]?.templateId).toBe('language-trainer');
    expect(parsed.gezels[0]?.voorman).toBe(true);
    expect(parsed.tools[0]?.name).toBe('advance_level');
    expect(parsed.schedules[0]?.consent).toBe('ask');
    expect(parsed.pages?.entry).toBe('dashboard/index.html');
    expect(parsed.nameTemplate).toBe('{{language}} Language Trainer');
    expect(parsed.meesterManaged).toBe(false);
    expect(parsed.indexingEnabled).toBe(false);
    expect(parsed.tabVisibility).toEqual({ overview: false, tasks: false, artifacts: true });
  });

  it('rejects a script-tool name that is not lowercase-snake', () => {
    const bad = ProjectTypeVersionManifestSchema.safeParse({
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-07-06T00:00:00Z',
      tools: [{ name: 'AdvanceLevel', description: 'x', script: 's' }],
    });
    expect(bad.success).toBe(false);
  });

  it('is discriminated correctly inside the top-level catalog union', () => {
    const resolved = {
      schemaVersion: 1 as const,
      kind: 'project-type' as const,
      id: 'email',
      name: 'Email / Inbox',
      description: 'Sync an inbox into a project.',
      tags: ['email'],
      maintainer: { name: 'Gezel' },
      version: '1.0.0',
      releasedAt: '2026-07-06T00:00:00Z',
      extends: 'email',
      availableVersions: ['1.0.0'],
    };
    const parsed = CatalogItemManifestSchema.parse(resolved);
    if (parsed.kind !== 'project-type') throw new Error('expected project-type');
    expect(parsed.id).toBe('email');
    // Direct resolved-schema parse agrees.
    expect(ProjectTypeManifestSchema.parse(resolved).extends).toBe('email');
  });

  it('carries the gallery category and rejects unknown values', () => {
    const resolved = {
      schemaVersion: 1 as const,
      kind: 'project-type' as const,
      id: 'language-trainer',
      name: 'Language Trainer',
      description: 'Practice a language with a tutor.',
      tags: ['language'],
      category: 'growth' as const,
      maintainer: { name: 'Gezel' },
      version: '1.0.0',
      releasedAt: '2026-07-06T00:00:00Z',
      availableVersions: ['1.0.0'],
    };
    expect(ProjectTypeManifestSchema.parse(resolved).category).toBe('growth');
    // Category stays optional for older/community manifests.
    const { category: _omitted, ...withoutCategory } = resolved;
    expect(ProjectTypeManifestSchema.parse(withoutCategory).category).toBeUndefined();
    expect(ProjectTypeManifestSchema.safeParse({ ...resolved, category: 'sports' }).success).toBe(
      false,
    );
  });
});

describe('interactive-page rails (pages.tools + reactions + page trigger)', () => {
  const base = {
    schemaVersion: 1 as const,
    version: '1.0.0',
    releasedAt: '2026-07-18T00:00:00Z',
  };

  it('parses a page-invokable tool surface with a reaction', () => {
    const parsed = ProjectTypeVersionManifestSchema.parse({
      ...base,
      scripts: { 'game-store': 'export const meta = {};' },
      tools: [
        {
          name: 'user_move',
          description: 'The user moved.',
          script: 'game-store',
          bind: { action: 'user_move' },
          reaction: {
            gezel: 'checkers-player',
            prompt: 'Opponent played {{output.lastMove}} — your turn.',
          },
        },
      ],
      pages: {
        entry: 'board/index.html',
        reads: [{ source: 'workspace', path: 'game.json' }],
        tools: ['user_move'],
      },
    });
    expect(parsed.pages?.tools).toEqual(['user_move']);
    expect(parsed.tools[0]?.reaction?.gezel).toBe('checkers-player');
  });

  it('rejects malformed page-tool names and empty reaction prompts', () => {
    expect(() =>
      ProjectTypeVersionManifestSchema.parse({
        ...base,
        pages: { entry: 'x.html', tools: ['Bad-Name'] },
      }),
    ).toThrow();
    expect(() =>
      ProjectTypeVersionManifestSchema.parse({
        ...base,
        tools: [
          {
            name: 'user_move',
            description: 'x',
            script: 's',
            reaction: { gezel: 'g', prompt: '' },
          },
        ],
      }),
    ).toThrow();
  });

  it('parses the page script-run trigger', () => {
    expect(ScriptRunTriggerSchema.parse({ kind: 'page', tool: 'user_move' })).toEqual({
      kind: 'page',
      tool: 'user_move',
    });
    expect(() => ScriptRunTriggerSchema.parse({ kind: 'page' })).toThrow();
  });
});

describe('wave-1 category additions', () => {
  it('accepts home, money, and events; still rejects unknowns', () => {
    expect(ProjectTypeCategorySchema.parse('home')).toBe('home');
    expect(ProjectTypeCategorySchema.parse('money')).toBe('money');
    expect(ProjectTypeCategorySchema.parse('events')).toBe('events');
    expect(() => ProjectTypeCategorySchema.parse('sports')).toThrow();
  });
});
