import { describe, expect, it } from 'vitest';
import {
  AskQuestionRequestSchema,
  ChatEventSchema,
  ChatMessageSchema,
  CreateProjectRequestSchema,
  CreateTaskRequestSchema,
  CreateTypedProjectRequestSchema,
  DocumentMediaExportRequestSchema,
  FileReviewReplySchema,
  GezelConfigSchema,
  GezelFrontmatterSchema,
  GezelSectionSchema,
  ProjectFileEntrySchema,
  ProjectSchema,
  TaskStatusSchema,
  UpdateProjectRequestSchema,
  UpdateTaskRequestSchema,
  parseTaskRef,
  projectAllowsAmbientWork,
  taskRef,
} from './index.js';

describe('DocumentMediaExportRequestSchema', () => {
  it('accepts Store-backed native media exports and rejects traversal', () => {
    expect(
      DocumentMediaExportRequestSchema.parse({
        markdown: '# Brief',
        selectedFile: 'notes/brief.md',
        format: 'mp4',
        source: { kind: 'documents' },
      }).format,
    ).toBe('mp4');
    expect(() =>
      DocumentMediaExportRequestSchema.parse({
        markdown: '# Brief',
        selectedFile: '../outside.md',
        format: 'gif',
        source: { kind: 'project-artifacts', projectId: 'project-1' },
      }),
    ).toThrow();
  });
});

describe('GezelFrontmatterSchema', () => {
  it('parses valid frontmatter', () => {
    const result = GezelFrontmatterSchema.parse({
      name: 'Test',
      model: 'gpt-4o',
      tuning: { sampling: { temperature: 0.7 } },
    });
    expect(result.name).toBe('Test');
    expect(result.model).toBe('gpt-4o');
    expect(result.tuning?.sampling?.temperature).toBe(0.7);
  });

  it('rejects missing name', () => {
    expect(() => GezelFrontmatterSchema.parse({})).toThrow();
  });

  it('rejects tuning temperature out of range', () => {
    expect(() =>
      GezelFrontmatterSchema.parse({ name: 'T', tuning: { sampling: { temperature: 3 } } }),
    ).toThrow();
  });

  it('strips the legacy top-level `temperature` field (removed from schema, migrated by Store)', () => {
    const result = GezelFrontmatterSchema.parse({ name: 'T', temperature: 0.7 } as unknown);
    expect((result as Record<string, unknown>).temperature).toBeUndefined();
  });
});

describe('ProjectSchema', () => {
  it('parses with optional workingDir', () => {
    const result = ProjectSchema.parse({
      id: 'test',
      name: 'Test',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
    expect(result.workingDir).toBeUndefined();
  });

  it('includes workingDir when provided', () => {
    const result = ProjectSchema.parse({
      id: 'test',
      name: 'Test',
      workingDir: '/Users/dev/project',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
    expect(result.workingDir).toBe('/Users/dev/project');
  });

  it('accepts an optional voormanGezelId', () => {
    const result = ProjectSchema.parse({
      id: 'test',
      name: 'Test',
      voormanGezelId: 'ada',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
    expect(result.voormanGezelId).toBe('ada');
  });

  it('accepts optional per-project tab visibility overrides', () => {
    const result = ProjectSchema.parse({
      id: 'focused',
      name: 'Focused',
      tabVisibility: { tasks: false, workspace: true },
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
    expect(result.tabVisibility).toEqual({ tasks: false, workspace: true });
  });

  it('accepts an explicit workspace-indexing opt-out', () => {
    const result = ProjectSchema.parse({
      id: 'checkers',
      name: 'Checkers',
      indexingEnabled: false,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
    expect(result.indexingEnabled).toBe(false);
  });
});

describe('Task schemas', () => {
  it('TaskStatusSchema accepts the four workflow values', () => {
    for (const s of ['paused', 'active', 'complete', 'canceled'] as const) {
      expect(TaskStatusSchema.parse(s)).toBe(s);
    }
    expect(() => TaskStatusSchema.parse('running')).toThrow();
  });

  it('taskRef / parseTaskRef round-trip', () => {
    expect(taskRef('website', 7)).toBe('website/7');
    expect(parseTaskRef('website/7')).toEqual({ projectId: 'website', num: 7 });
    expect(parseTaskRef('deep/nested/42')).toEqual({ projectId: 'deep/nested', num: 42 });
    expect(parseTaskRef('no-num/')).toBeNull();
    expect(parseTaskRef('no-slash')).toBeNull();
    expect(parseTaskRef('bad/-1')).toBeNull();
    expect(parseTaskRef('bad/0')).toBeNull();
  });
});

describe('AskQuestionRequestSchema', () => {
  const base = {
    projectId: 'website',
    gezelId: 'reviewer',
    sessionId: 'session-1',
    prompt: 'Ready to approve?',
  };

  it('accepts canonical task refs', () => {
    expect(AskQuestionRequestSchema.parse({ ...base, taskRef: 'website/7' }).taskRef).toBe(
      'website/7',
    );
  });

  it('rejects task titles passed as task refs', () => {
    expect(() => AskQuestionRequestSchema.parse({ ...base, taskRef: 'Spanish Lang' })).toThrow(
      'task ref must use projectId/num form',
    );
  });
});

describe('ChatMessageSchema', () => {
  it('validates user and assistant roles', () => {
    expect(ChatMessageSchema.parse({ role: 'user', content: 'hi', at: '2026-01-01' }).role).toBe(
      'user',
    );
    expect(
      ChatMessageSchema.parse({ role: 'assistant', content: 'hello', at: '2026-01-01' }).role,
    ).toBe('assistant');
    expect(() =>
      ChatMessageSchema.parse({ role: 'system', content: 'x', at: '2026-01-01' }),
    ).toThrow();
  });

  it('accepts a non-negative observed reasoning duration', () => {
    const parsed = ChatMessageSchema.parse({
      role: 'assistant',
      content: 'hello',
      at: '2026-01-01',
      reasoning: 'I should answer clearly.',
      reasoningDurationMs: 1_250,
    });
    expect(parsed.reasoningDurationMs).toBe(1_250);
    expect(() =>
      ChatMessageSchema.parse({
        role: 'assistant',
        content: 'hello',
        at: '2026-01-01',
        reasoningDurationMs: -1,
      }),
    ).toThrow();
  });
});

describe('ChatEventSchema', () => {
  it('discriminates by type', () => {
    expect(ChatEventSchema.parse({ type: 'delta', content: 'chunk' }).type).toBe('delta');
    expect(ChatEventSchema.parse({ type: 'reasoning_delta', content: 'thinking' }).type).toBe(
      'reasoning_delta',
    );
    expect(ChatEventSchema.parse({ type: 'done' }).type).toBe('done');
    expect(ChatEventSchema.parse({ type: 'error', error: 'oops' }).type).toBe('error');
    expect(ChatEventSchema.parse({ type: 'cancelled' }).type).toBe('cancelled');
    expect(
      ChatEventSchema.parse({ type: 'gezel_created', gezelId: 'sipho', name: 'Sipho' }).type,
    ).toBe('gezel_created');
  });

  it('accepts an in-app Settings action on a warning', () => {
    expect(
      ChatEventSchema.parse({
        type: 'warning',
        message: 'A model update is available in Settings.',
        action: { kind: 'settings', section: 'mlx' },
      }),
    ).toMatchObject({
      action: { kind: 'settings', section: 'mlx' },
    });
  });

  it('accepts a short or summarized tool response', () => {
    expect(
      ChatEventSchema.parse({
        type: 'tool',
        name: 'suggest_craftbook',
        durationMs: 42,
        success: true,
        resultText: 'Matched presentations/powerpoint',
        resultTruncated: false,
      }),
    ).toMatchObject({
      resultText: 'Matched presentations/powerpoint',
      resultTruncated: false,
    });
  });
});

describe('ProjectFileEntrySchema', () => {
  it('parses file entries', () => {
    const entry = ProjectFileEntrySchema.parse({
      name: 'readme.md',
      path: 'docs/readme.md',
      isDirectory: false,
    });
    expect(entry.isDirectory).toBe(false);
  });
});

describe('CreateProjectRequestSchema', () => {
  const base = {
    name: 'Sample',
    about:
      'This is a paragraph-level description of who the project is for and what is in scope. Long enough.',
    missionObjectives: '- First concrete outcome\n- Second concrete outcome',
  };

  it('accepts a full project with about + missionObjectives', () => {
    expect(() => CreateProjectRequestSchema.parse(base)).not.toThrow();
  });

  it('accepts a workspace-indexing preference at creation', () => {
    expect(
      CreateProjectRequestSchema.parse({ ...base, indexingEnabled: false }).indexingEnabled,
    ).toBe(false);
  });

  // about/missionObjectives are encouraged, not required, at the wire level:
  // the "from folder" flow creates projects without them (context comes from
  // the folder's files). The New Project dialog still enforces richness
  // minimums for the blank/GitHub flows — that's a UI concern, not a wire one.
  it('accepts a missing about', () => {
    const { about, ...rest } = base;
    void about;
    expect(() => CreateProjectRequestSchema.parse(rest)).not.toThrow();
  });

  it('accepts a missing missionObjectives', () => {
    const { missionObjectives, ...rest } = base;
    void missionObjectives;
    expect(() => CreateProjectRequestSchema.parse(rest)).not.toThrow();
  });

  it('accepts a short about', () => {
    expect(() => CreateProjectRequestSchema.parse({ ...base, about: 'short' })).not.toThrow();
  });

  it('accepts a short missionObjectives', () => {
    expect(() =>
      CreateProjectRequestSchema.parse({ ...base, missionObjectives: 'tiny' }),
    ).not.toThrow();
  });

  it('still requires a name', () => {
    const { name, ...rest } = base;
    void name;
    expect(() => CreateProjectRequestSchema.parse(rest)).toThrow();
  });
});

describe('CreateTypedProjectRequestSchema', () => {
  it('accepts only creation metadata plus the project-type application request', () => {
    const parsed = CreateTypedProjectRequestSchema.parse({
      name: 'Spanish Practice',
      mode: 'solo',
      about: 'client placeholder must not be accepted as transaction input',
      missionObjectives: 'client placeholder must not be accepted either',
      projectType: {
        typeId: 'language-trainer',
        version: '1.0.0',
        params: { language: 'Spanish' },
      },
    });

    expect(parsed).toEqual({
      name: 'Spanish Practice',
      mode: 'solo',
      projectType: {
        typeId: 'language-trainer',
        version: '1.0.0',
        params: { language: 'Spanish' },
      },
    });
  });

  it('requires a project type', () => {
    expect(() => CreateTypedProjectRequestSchema.parse({ name: 'Incomplete' })).toThrow();
  });
});

describe('UpdateProjectRequestSchema', () => {
  it('accepts a per-project workspace-indexing switch', () => {
    expect(UpdateProjectRequestSchema.parse({ indexingEnabled: false }).indexingEnabled).toBe(
      false,
    );
  });

  it('accepts a per-project Meester progress-check override', () => {
    const nudgeConfig = { enabled: false, slowIntervalMs: 12 * 60 * 60_000 };
    const parsed = UpdateProjectRequestSchema.parse({ nudgeConfig });

    expect(parsed.nudgeConfig).toEqual(nudgeConfig);
  });

  it('accepts project tab visibility flags and rejects unknown tab names', () => {
    expect(
      UpdateProjectRequestSchema.parse({
        tabVisibility: { overview: false, tasks: false, approvals: true },
      }).tabVisibility,
    ).toEqual({ overview: false, tasks: false, approvals: true });
    expect(() => UpdateProjectRequestSchema.parse({ tabVisibility: { chat: false } })).toThrow();
  });

  it('accepts exact HTTPS toolset origins and rejects paths or insecure origins', () => {
    expect(
      UpdateProjectRequestSchema.parse({
        credentialAllowedOrigins: { 'vendor.token': ['https://api.vendor.test'] },
      }).credentialAllowedOrigins,
    ).toEqual({ 'vendor.token': ['https://api.vendor.test'] });
    expect(() =>
      UpdateProjectRequestSchema.parse({
        credentialAllowedOrigins: { 'vendor.token': ['http://api.vendor.test'] },
      }),
    ).toThrow();
    expect(() =>
      UpdateProjectRequestSchema.parse({
        credentialAllowedOrigins: { 'vendor.token': ['https://api.vendor.test/items'] },
      }),
    ).toThrow();
  });
});

describe('CreateTaskRequestSchema', () => {
  const base = {
    title: 'Build the thing',
    description:
      'A reasonable job-to-be-done spelled out over at least forty characters so it stops being vapor.',
    assignee: { kind: 'gezel' as const, gezelId: 'leo' },
    steps: [{ name: 'Main' }],
  };

  it('accepts a task with a proper description', () => {
    expect(() => CreateTaskRequestSchema.parse(base)).not.toThrow();
  });

  it('rejects a missing description', () => {
    const { description, ...rest } = base;
    void description;
    expect(() => CreateTaskRequestSchema.parse(rest)).toThrow();
  });

  it('rejects a too-short description', () => {
    expect(() => CreateTaskRequestSchema.parse({ ...base, description: 'too short' })).toThrow();
  });

  it('round-trips an optional plan field', () => {
    const parsed = CreateTaskRequestSchema.parse({
      ...base,
      plan: '1. Research\n2. Draft\n3. Review',
    });
    expect(parsed.plan).toBe('1. Research\n2. Draft\n3. Review');
  });

  it('dispatchEntry parses on a plain active create', () => {
    const parsed = CreateTaskRequestSchema.parse({ ...base, dispatchEntry: true });
    expect(parsed.dispatchEntry).toBe(true);
  });

  it('dispatchEntry is rejected on drafts and spawn hosts', () => {
    expect(() =>
      CreateTaskRequestSchema.parse({ ...base, dispatchEntry: true, status: 'draft' }),
    ).toThrow(/dispatchEntry/);
    expect(() =>
      CreateTaskRequestSchema.parse({
        ...base,
        dispatchEntry: true,
        cron: { expression: '0 9 * * *' },
        spawnsSteps: [{ name: 'Child' }],
      }),
    ).toThrow(/dispatchEntry/);
    expect(() =>
      CreateTaskRequestSchema.parse({
        ...base,
        dispatchEntry: true,
        fanout: { count: 2 },
        spawnsSteps: [{ name: 'Child' }],
      }),
    ).toThrow(/dispatchEntry/);
  });
});

describe('UpdateTaskRequestSchema', () => {
  it('allows updating just the plan field', () => {
    const parsed = UpdateTaskRequestSchema.parse({ plan: 'new plan' });
    expect(parsed.plan).toBe('new plan');
  });

  it('lets an empty plan string through (callers use that to clear)', () => {
    const parsed = UpdateTaskRequestSchema.parse({ plan: '' });
    expect(parsed.plan).toBe('');
  });
});

describe('Codex CLI config', () => {
  it('accepts current model-dependent reasoning effort values', () => {
    for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
      expect(
        GezelConfigSchema.parse({ codexCli: { defaultReasoningEffort: effort } }).codexCli
          ?.defaultReasoningEffort,
      ).toBe(effort);
    }
  });

  it('rejects reasoning labels that Codex CLI does not understand', () => {
    expect(() =>
      GezelConfigSchema.parse({ codexCli: { defaultReasoningEffort: 'none' } }),
    ).toThrow();
  });
});

describe('openaiEndpoints config', () => {
  it('parses the Connected Apps endpoint controls and tolerates absence', () => {
    const cfg = GezelConfigSchema.parse({
      openaiEndpoints: {
        enabled: false,
        servingGezelId: 'mira',
        supportingBehaviors: false,
        emulateOllama: true,
      },
    });
    expect(cfg.openaiEndpoints?.enabled).toBe(false);
    expect(cfg.openaiEndpoints?.servingGezelId).toBe('mira');
    expect(cfg.openaiEndpoints?.supportingBehaviors).toBe(false);
    expect(cfg.openaiEndpoints?.emulateOllama).toBe(true);
    // Absent block parses — unset means the facade is on with no
    // serving gezel, and the whole config must not fail over it.
    expect(GezelConfigSchema.parse({}).openaiEndpoints).toBeUndefined();
  });
});

describe('fileReviews config + reply contract', () => {
  it('parses the fileReviews config block and defaults enabled to true', () => {
    const cfg = GezelConfigSchema.parse({
      fileReviews: { disabledKinds: ['config'] },
    });
    expect(cfg.fileReviews?.enabled).toBe(true);
    expect(cfg.fileReviews?.disabledKinds).toEqual(['config']);
    // Absent block parses too — the feature must not fail the whole config.
    expect(GezelConfigSchema.parse({}).fileReviews).toBeUndefined();
  });

  it('FileReviewReplySchema enforces the strict LLM contract', () => {
    const ok = FileReviewReplySchema.parse({
      notes_md: 'Does a thing.',
      issues: [{ severity: 'major', category: 'bug', message: 'off by one', line: 3 }],
      health: 4,
      health_reason: 'likely bug',
    });
    expect(ok.health).toBe(4);
    expect(() =>
      FileReviewReplySchema.parse({ notes_md: 'x', issues: [], health: 11, health_reason: 'r' }),
    ).toThrow();
    expect(() =>
      FileReviewReplySchema.parse({ notes_md: '', issues: [], health: 5, health_reason: 'r' }),
    ).toThrow();
  });
});

describe('document export preferences', () => {
  it('accepts the complete quick-export settings block', () => {
    const cfg = GezelConfigSchema.parse({
      documentExportOptions: {
        format: 'html',
        themeId: 'gezellig',
        transformStyle: 'documentary',
        pageSize: 'a4',
        htmlStyle: 'rendered',
        htmlBundle: 'zip',
      },
    });

    expect(cfg.documentExportOptions).toEqual({
      format: 'html',
      themeId: 'gezellig',
      transformStyle: 'documentary',
      pageSize: 'a4',
      htmlStyle: 'rendered',
      htmlBundle: 'zip',
    });
  });

  it('rejects partial or unknown export settings', () => {
    expect(() =>
      GezelConfigSchema.parse({
        documentExportOptions: { format: 'pdf', pageSize: 'tabloid' },
      }),
    ).toThrow();
  });
});

describe('Night Shift model defaults', () => {
  it('parses an optional provider/model override without changing the inherited default', () => {
    expect(GezelConfigSchema.parse({}).nightShift).toBeUndefined();

    const cfg = GezelConfigSchema.parse({
      nightShift: {
        modelOverride: {
          enabled: true,
          provider: 'llama-cpp',
          model: 'qwen-slow-but-thorough',
        },
      },
    });

    expect(cfg.nightShift?.modelOverride).toEqual({
      enabled: true,
      provider: 'llama-cpp',
      model: 'qwen-slow-but-thorough',
    });
  });
});

describe('projectAllowsAmbientWork', () => {
  it('allows ambient work only when active or unset', () => {
    expect(projectAllowsAmbientWork({ status: 'active' })).toBe(true);
    expect(projectAllowsAmbientWork({})).toBe(true); // unset → active
  });

  it('pauses ambient work for readonly, inactive, AND stable', () => {
    // `stable` is the lifecycle "finished/at rest" state — it must gate
    // scheduler nudges exactly like the deliberate user pauses, so a
    // closed-out project stops getting "anything stuck?" check-ins.
    expect(projectAllowsAmbientWork({ status: 'readonly' })).toBe(false);
    expect(projectAllowsAmbientWork({ status: 'inactive' })).toBe(false);
    expect(projectAllowsAmbientWork({ status: 'stable' })).toBe(false);
  });

  it('accepts `stable` as a valid ProjectSchema status', () => {
    const parsed = ProjectSchema.parse({
      id: 'p',
      name: 'P',
      status: 'stable',
      createdAt: 't',
      updatedAt: 't',
    });
    expect(parsed.status).toBe('stable');
  });
});
