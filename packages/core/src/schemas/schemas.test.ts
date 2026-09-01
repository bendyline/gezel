import { describe, expect, it } from 'vitest';
import {
  AskQuestionRequestSchema,
  BoekwachterIssueSchema,
  ChatEventEnvelopeSchema,
  ChatEventSchema,
  ChatMessageSchema,
  ChatMessageToolCallSchema,
  CraftbookTemplateIdentitySchema,
  CreateProjectRequestSchema,
  CreateTaskRequestSchema,
  CreateTypedProjectRequestSchema,
  DocumentMediaExportRequestSchema,
  FileReviewReplySchema,
  GezelConfigSchema,
  GezelFrontmatterSchema,
  GezelSectionSchema,
  ModelContextOverrideUpdateSchema,
  ProjectFileEntrySchema,
  ProjectSchema,
  ProjectSearchResponseSchema,
  TaskStatusSchema,
  UpdateBoekwachterIssueRequestSchema,
  UpdateConfigRequestSchema,
  UpdateProjectRequestSchema,
  UpdateTaskRequestSchema,
  parseTaskRef,
  projectAllowsAmbientWork,
  projectAllowsWorkspaceTables,
  taskRef,
} from './index.js';

describe('CraftbookTemplateIdentitySchema', () => {
  const identity = {
    schemaVersion: 1,
    kind: 'craftbook-template',
    id: 'starter',
    name: 'Starter',
    description: 'Start a blank project.',
    tags: [],
    maintainer: { name: 'Gezel' },
  } as const;

  it('defaults older identities to general and accepts lifecycle roles', () => {
    expect(CraftbookTemplateIdentitySchema.parse(identity).role).toBe('general');
    expect(
      CraftbookTemplateIdentitySchema.parse({ ...identity, role: 'project-starter' }).role,
    ).toBe('project-starter');
  });
});

describe('microphone input config', () => {
  it('persists an origin id with a label fallback and accepts null to reset', () => {
    expect(
      GezelConfigSchema.parse({
        microphoneDeviceId: 'browser-device-id',
        microphoneDeviceLabel: 'Studio microphone',
      }),
    ).toMatchObject({
      microphoneDeviceId: 'browser-device-id',
      microphoneDeviceLabel: 'Studio microphone',
    });
    expect(
      UpdateConfigRequestSchema.parse({
        microphoneDeviceId: null,
        microphoneDeviceLabel: null,
      }),
    ).toMatchObject({ microphoneDeviceId: null, microphoneDeviceLabel: null });
  });
});

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

describe('Boekwachter issue schemas', () => {
  const issue = {
    id: 'issue-3',
    ref: 'BW-3',
    fingerprint: 'fingerprint',
    path: 'docs/guide.md',
    line: 14,
    severity: 'minor',
    category: 'clarity',
    message: 'The owner is unclear.',
    status: 'open',
    seen: false,
    stale: true,
    createdAt: '2026-08-12T00:00:00.000Z',
    lastSeenAt: '2026-08-12T00:00:00.000Z',
  };

  it('accepts a durable issue with an explicitly historical line anchor', () => {
    expect(BoekwachterIssueSchema.parse(issue)).toMatchObject({ ref: 'BW-3', stale: true });
    expect(() => BoekwachterIssueSchema.parse({ ...issue, ref: 'issue-3' })).toThrow();
  });

  it('requires a dismissal reason only for dismissed lifecycle updates', () => {
    expect(
      UpdateBoekwachterIssueRequestSchema.parse({
        ref: 'BW-3',
        status: 'dismissed',
        dismissalReason: 'not_an_issue',
      }),
    ).toMatchObject({ status: 'dismissed' });
    expect(() =>
      UpdateBoekwachterIssueRequestSchema.parse({ ref: 'BW-3', status: 'dismissed' }),
    ).toThrow();
    expect(() =>
      UpdateBoekwachterIssueRequestSchema.parse({
        ref: 'BW-3',
        status: 'resolved',
        dismissalReason: 'not_an_issue',
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

  it('accepts bounded indexed-context policies', () => {
    const result = GezelFrontmatterSchema.parse({
      name: 'T',
      retrieval: { mode: 'lean', maxTokens: 240, sources: ['workspace', 'shared'] },
    });
    expect(result.retrieval).toEqual({
      mode: 'lean',
      maxTokens: 240,
      sources: ['workspace', 'shared'],
    });
    expect(() =>
      GezelFrontmatterSchema.parse({
        name: 'T',
        retrieval: { mode: 'deep', maxTokens: 16_001 },
      }),
    ).toThrow();
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

  it('parses one-way project links and defaults to no links', () => {
    const plain = ProjectSchema.parse({
      id: 'project-a',
      name: 'Project A',
      createdAt: '2026-08-19T00:00:00.000Z',
      updatedAt: '2026-08-19T00:00:00.000Z',
    });
    expect(plain.linkedProjectIds).toBeUndefined();

    const linked = ProjectSchema.parse({ ...plain, linkedProjectIds: ['project-b'] });
    expect(linked.linkedProjectIds).toEqual(['project-b']);
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

describe('ProjectSearchResponseSchema', () => {
  it('carries directly invokable Gilde and local craftbook options beside search results', () => {
    const parsed = ProjectSearchResponseSchema.parse({
      results: [],
      truncated: false,
      craftbooks: [
        {
          id: 'vehicle-physics',
          name: 'Vehicle physics',
          source: 'bundled',
          stepCount: 4,
          score: 0.6,
          invocation: {
            tool: 'invoke_craftbook',
            arguments: {
              craftbookId: 'vehicle-physics',
              description: 'Improve the physics for how cars drive',
            },
          },
        },
      ],
    });

    expect(parsed.craftbooks[0]?.source).toBe('bundled');
    expect(parsed.craftbooks[0]?.invocation.tool).toBe('invoke_craftbook');
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

  it('marks a machine-authored user turn without disturbing older messages', () => {
    // A dispatch seed keeps the user role providers require, plus the
    // marker that stops the UI attributing it to the person.
    const seed = ChatMessageSchema.parse({
      role: 'user',
      content: 'Task p1/1 has advanced to the next step.',
      at: '2026-01-01',
      origin: 'system',
    });
    expect(seed.origin).toBe('system');
    // Every session written before the field existed must still parse.
    expect(
      ChatMessageSchema.parse({ role: 'user', content: 'hi', at: '2026-01-01' }).origin,
    ).toBeUndefined();
    expect(() =>
      ChatMessageSchema.parse({
        role: 'user',
        content: 'hi',
        at: '2026-01-01',
        origin: 'assistant',
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
    expect(ChatEventSchema.parse({ type: 'user_message_pending', preview: 'hello' }).type).toBe(
      'user_message_pending',
    );
    expect(ChatEventSchema.parse({ type: 'cancelled' }).type).toBe('cancelled');
    expect(
      ChatEventSchema.parse({ type: 'gezel_created', gezelId: 'sipho', name: 'Sipho' }).type,
    ).toBe('gezel_created');
    expect(
      ChatEventSchema.parse({
        type: 'task_event',
        eventId: 'event-1',
        kind: 'task.status.changed',
        summary: 'Task default/1 → paused',
        at: '2026-08-08T12:00:00.000Z',
        taskRef: 'default/1',
        gezelId: 'reviewer',
      }),
    ).toMatchObject({ type: 'task_event', gezelId: 'reviewer' });
  });

  it('carries parent-session lineage on multiplexed live events', () => {
    const envelope = ChatEventEnvelopeSchema.parse({
      sessionId: 'child',
      gezelId: 'researcher',
      projectId: 'default',
      parentSession: {
        sessionId: 'parent',
        gezelId: 'meester',
        kind: 'consultation',
      },
      handoffFrom: {
        sessionId: 'previous-step',
        gezelId: 'planner',
      },
      event: { type: 'delta', content: 'Working' },
    });
    expect(envelope.parentSession?.sessionId).toBe('parent');
    expect(envelope.handoffFrom?.sessionId).toBe('previous-step');
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

  it('carries an inline tool card on tool events and rejects malformed ones', () => {
    const card = {
      kind: 'craftbook-start',
      craftbookId: 'powerpoint-deck',
      craftbookName: 'PowerPoint from Content',
      taskRef: 'default/12',
      projectId: 'default',
      status: 'active',
      activeStepId: 'research',
      steps: [{ id: 'research', name: 'Acquire and verify sources', status: 'active' }],
      recommendsExternalServices: { reason: 'verifies sources with live web search' },
    };
    const base = { type: 'tool', name: 'invoke_craftbook', durationMs: 42, success: true };
    expect(ChatEventSchema.parse({ ...base, card })).toMatchObject({ card });
    // Same payload round-trips on the persisted tool-call record.
    expect(
      ChatMessageToolCallSchema.parse({
        name: 'invoke_craftbook',
        durationMs: 42,
        success: true,
        card,
      }),
    ).toMatchObject({ card });
    expect(() =>
      ChatEventSchema.parse({ ...base, card: { ...card, kind: 'mystery-card' } }),
    ).toThrow();
    expect(() =>
      ChatEventSchema.parse({
        ...base,
        card: { ...card, steps: [{ id: 'research', name: 'Research', status: 'started' }] },
      }),
    ).toThrow();
  });

  it('parses the step-advance card variant', () => {
    expect(
      ChatMessageToolCallSchema.parse({
        name: 'advance_task_step',
        durationMs: 42,
        success: true,
        card: {
          kind: 'task-step-advance',
          craftbookId: 'powerpoint-deck',
          craftbookName: 'PowerPoint from Content',
          taskRef: 'default/12',
          projectId: 'default',
          status: 'active',
          completedStepId: 'research',
          completedStepName: 'Acquire and verify sources',
          activeStepId: 'outline',
          activeStepName: 'Lock the slide outline',
          steps: [
            { id: 'research', name: 'Acquire and verify sources', status: 'done' },
            { id: 'outline', name: 'Lock the slide outline', status: 'active' },
          ],
        },
      }).card,
    ).toMatchObject({ kind: 'task-step-advance', completedStepId: 'research' });
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

  it('accepts a project maker-mark override at creation', () => {
    expect(CreateProjectRequestSchema.parse({ ...base, icon: 'code' }).icon).toBe('code');
    expect(() => CreateProjectRequestSchema.parse({ ...base, icon: 'rocketship' })).toThrow();
  });

  it('accepts an existing folder at creation', () => {
    expect(
      CreateProjectRequestSchema.parse({ ...base, workingDir: '/work/sample' }).workingDir,
    ).toBe('/work/sample');
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
  it('accepts the project archive flag', () => {
    expect(UpdateProjectRequestSchema.parse({ archived: true }).archived).toBe(true);
    expect(UpdateProjectRequestSchema.parse({ archived: false }).archived).toBe(false);
  });

  it('accepts replacing or clearing project links', () => {
    expect(UpdateProjectRequestSchema.parse({ linkedProjectIds: ['project-b'] })).toEqual({
      linkedProjectIds: ['project-b'],
    });
    expect(UpdateProjectRequestSchema.parse({ linkedProjectIds: [] })).toEqual({
      linkedProjectIds: [],
    });
    expect(() => UpdateProjectRequestSchema.parse({ linkedProjectIds: ['not valid'] })).toThrow();
  });

  it('sets or clears a project maker-mark override', () => {
    expect(UpdateProjectRequestSchema.parse({ icon: 'quill' }).icon).toBe('quill');
    expect(UpdateProjectRequestSchema.parse({ icon: null }).icon).toBeNull();
  });

  it('accepts a per-project workspace-indexing switch', () => {
    expect(UpdateProjectRequestSchema.parse({ indexingEnabled: false }).indexingEnabled).toBe(
      false,
    );
  });

  it('accepts the named managed workspace-write policy', () => {
    expect(
      UpdateProjectRequestSchema.parse({ managedWorkspaceWritePolicy: 'deny' })
        .managedWorkspaceWritePolicy,
    ).toBe('deny');
    expect(() =>
      UpdateProjectRequestSchema.parse({ managedWorkspaceWritePolicy: 'sometimes' }),
    ).toThrow();
  });

  it('accepts provider-native project permission overrides', () => {
    expect(UpdateProjectRequestSchema.parse({ codexPermissionMode: 'reviewed' })).toMatchObject({
      codexPermissionMode: 'reviewed',
    });
    expect(
      UpdateProjectRequestSchema.parse({ claudePermissionMode: 'bypassPermissions' }),
    ).toMatchObject({ claudePermissionMode: 'bypassPermissions' });
    expect(() => UpdateProjectRequestSchema.parse({ claudePermissionMode: 'reviewed' })).toThrow();
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

  it('round-trips the session that launched the task', () => {
    const parsed = CreateTaskRequestSchema.parse({
      ...base,
      launchSessionId: 'session-meester-1',
    });
    expect(parsed.launchSessionId).toBe('session-meester-1');
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

describe('CLI presentation config', () => {
  it('persists the CLI detail display flags', () => {
    expect(GezelConfigSchema.parse({ cliShowThinking: true }).cliShowThinking).toBe(true);
    expect(GezelConfigSchema.parse({ cliShowWrites: true }).cliShowWrites).toBe(true);
    expect(GezelConfigSchema.parse({}).cliShowThinking).toBeUndefined();
    expect(GezelConfigSchema.parse({}).cliShowWrites).toBeUndefined();
    expect(() => GezelConfigSchema.parse({ cliShowThinking: 'yes' })).toThrow();
    expect(() => GezelConfigSchema.parse({ cliShowWrites: 'yes' })).toThrow();
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

describe('llama.cpp context sizing config', () => {
  it('accepts the two engine policies and rejects unknown modes', () => {
    expect(
      GezelConfigSchema.parse({ llamaCppContextSizing: 'adaptive' }).llamaCppContextSizing,
    ).toBe('adaptive');
    expect(
      GezelConfigSchema.parse({ llamaCppContextSizing: 'model-max' }).llamaCppContextSizing,
    ).toBe('model-max');
    expect(() => GezelConfigSchema.parse({ llamaCppContextSizing: 'unsafe-max' })).toThrow();
  });
});

describe('per-model context overrides config', () => {
  it('accepts an engine-keyed token map and tolerates absence', () => {
    const cfg = GezelConfigSchema.parse({
      modelContextOverrides: { 'llama-cpp:qwen3.6-27b-q4': 98_304, 'mlx:gemma4-e4b': 131_072 },
    });
    expect(cfg.modelContextOverrides?.['llama-cpp:qwen3.6-27b-q4']).toBe(98_304);
    expect(GezelConfigSchema.parse({}).modelContextOverrides).toBeUndefined();
  });

  it('rejects non-positive and fractional token counts', () => {
    expect(() =>
      GezelConfigSchema.parse({ modelContextOverrides: { 'llama-cpp:m': 0 } }),
    ).toThrow();
    expect(() =>
      GezelConfigSchema.parse({ modelContextOverrides: { 'llama-cpp:m': -4096 } }),
    ).toThrow();
    expect(() =>
      GezelConfigSchema.parse({ modelContextOverrides: { 'llama-cpp:m': 1024.5 } }),
    ).toThrow();
  });

  it('bounds the update wire shape and allows null to clear', () => {
    expect(ModelContextOverrideUpdateSchema.parse({ contextTokens: 32_768 }).contextTokens).toBe(
      32_768,
    );
    expect(
      ModelContextOverrideUpdateSchema.parse({ contextTokens: null }).contextTokens,
    ).toBeNull();
    expect(() => ModelContextOverrideUpdateSchema.parse({ contextTokens: 16_384 })).toThrow();
    expect(() => ModelContextOverrideUpdateSchema.parse({ contextTokens: 8_388_608 })).toThrow();
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

  it('accepts the optional project archive flag', () => {
    const parsed = ProjectSchema.parse({
      id: 'p',
      name: 'P',
      archived: true,
      status: 'inactive',
      createdAt: 't',
      updatedAt: 't',
    });
    expect(parsed.archived).toBe(true);
  });
});

describe('projectAllowsWorkspaceTables', () => {
  it('is on by default, because the size threshold already gates it', () => {
    expect(projectAllowsWorkspaceTables({})).toBe(true);
    expect(projectAllowsWorkspaceTables({ workspaceTablesEnabled: true })).toBe(true);
  });

  it('has a findable off switch for a project full of data fixtures', () => {
    expect(projectAllowsWorkspaceTables({ workspaceTablesEnabled: false })).toBe(false);
  });
});
