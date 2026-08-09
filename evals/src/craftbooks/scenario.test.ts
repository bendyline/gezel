import { describe, expect, it, vi } from 'vitest';
import type { MockServicesRuntime } from '../mock/mock-server.ts';
import type { EvalContext } from '../types.ts';
import { craftbookScenarioFromSpec, prioritizeRepairFailures } from './scenario.ts';
import type { CraftbookEvalSpec } from './types.ts';

function directWorkerSpec(): CraftbookEvalSpec {
  return {
    craftbookId: 'sample-book',
    scenarioId: 'craftbook-sample-book',
    title: 'Sample craftbook',
    objective: 'Exercise the generic adapter direct-worker path.',
    prompt: 'Use the Sample craftbook to build workspace/index.html.',
    setup: {
      projectName: 'Sample Project',
      worker: {
        name: 'Ada',
        role: 'Developer',
      },
    },
    success: {
      summary: 'workspace/index.html exists.',
    },
    coverage: {
      status: 'implemented',
    },
    qualityFocus: ['direct worker setup'],
  };
}

describe('craftbook generic scenario adapter', () => {
  it('can kick off a configured worker directly in the seeded project', async () => {
    const client = {
      listProjects: vi.fn().mockResolvedValue({ projects: [] }),
      createProject: vi.fn().mockResolvedValue({ id: 'project-1' }),
      createGezel: vi.fn().mockResolvedValue({ id: 'gezel-1' }),
      listGezels: vi.fn(),
      addGezelToProject: vi.fn().mockResolvedValue({
        projectId: 'project-1',
        gezelIds: ['gezel-1'],
        added: true,
      }),
      sendChatMessage: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const logs: string[] = [];
    const spec = directWorkerSpec();
    const scenario = craftbookScenarioFromSpec(spec);

    expect(scenario.skipInitialPrompt).toBe(true);
    await scenario.setup?.({
      client,
      meesterId: 'meester',
      log: (line: string) => logs.push(line),
      logChanged: (_key: string, line: string) => logs.push(line),
    } as unknown as EvalContext);

    expect(client.createProject).toHaveBeenCalledWith({
      name: 'Sample Project',
      about: expect.stringContaining('Eval harness rules'),
      missionObjectives: expect.stringContaining('do not stop after creating or assigning it'),
    });
    expect(client.createGezel).toHaveBeenCalledWith({ name: 'Ada', role: 'Developer' });
    expect(client.addGezelToProject).toHaveBeenCalledWith('project-1', 'gezel-1');
    expect(client.sendChatMessage).toHaveBeenCalledWith('gezel-1', {
      message: expect.stringContaining(spec.prompt ?? ''),
      projectId: 'project-1',
    });
    expect(client.sendChatMessage).toHaveBeenCalledWith('gezel-1', {
      message: expect.stringContaining('workspace file tools'),
      projectId: 'project-1',
    });
    expect(logs.some((line) => line.includes('sent kickoff to Ada'))).toBe(true);
  });

  it('routes binary office outputs through DocBlocks instead of write_file', async () => {
    const client = {
      listProjects: vi.fn().mockResolvedValue({ projects: [] }),
      createProject: vi.fn().mockResolvedValue({ id: 'project-1' }),
      createGezel: vi.fn().mockResolvedValue({ id: 'gezel-1' }),
      installToolset: vi.fn().mockResolvedValue({ ok: true }),
      listGezels: vi.fn(),
      addGezelToProject: vi.fn().mockResolvedValue({
        projectId: 'project-1',
        gezelIds: ['gezel-1'],
        added: true,
      }),
      sendChatMessage: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const spec: CraftbookEvalSpec = {
      ...directWorkerSpec(),
      success: {
        summary: 'A reviewed source and real PPTX exist.',
        deliverables: [
          { path: 'deck.md', kind: 'markdown-doc', minBytes: 100 },
          { path: 'deliverables/deck.pptx', kind: 'slide-deck', minBytes: 1000 },
        ],
      },
    };
    const scenario = craftbookScenarioFromSpec(spec);

    await scenario.setup?.({
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
    } as unknown as EvalContext);

    const projectArgs = client.createProject.mock.calls[0]![0];
    expect(projectArgs.missionObjectives).toContain('convert_document');
    expect(projectArgs.missionObjectives).toContain('copy_artifact_to_workspace');
    const kickoff = client.sendChatMessage.mock.calls[0]![1].message as string;
    expect(kickoff).toContain('Write the text workspace deliverable');
    expect(kickoff).toContain('deck.md');
    expect(kickoff).toContain('convert_document');
    expect(kickoff).toContain('preview_document');
    expect(kickoff).toContain('save_artifact');
    expect(kickoff).toContain('copy_artifact_to_workspace');
    expect(kickoff).not.toContain('write_file({ path: "deliverables/deck.pptx"');
  });

  it('runs a spawn/fanout book as a dispatched craftbook task instead of a freehand kickoff', async () => {
    const client = {
      listProjects: vi.fn().mockResolvedValue({ projects: [] }),
      createProject: vi.fn().mockResolvedValue({ id: 'project-1' }),
      createGezel: vi.fn().mockResolvedValue({ id: 'gezel-1' }),
      listGezels: vi.fn(),
      addGezelToProject: vi.fn().mockResolvedValue({
        projectId: 'project-1',
        gezelIds: ['gezel-1'],
        added: true,
      }),
      createTask: vi.fn().mockResolvedValue({ ref: 'project-1/1' }),
      sendChatMessage: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const logs: string[] = [];
    const spec: CraftbookEvalSpec = { ...directWorkerSpec(), runAsCraftbookTask: true };
    const scenario = craftbookScenarioFromSpec(spec);

    await scenario.setup?.({
      client,
      meesterId: 'meester',
      log: (line: string) => logs.push(line),
      logChanged: (_key: string, line: string) => logs.push(line),
    } as unknown as EvalContext);

    expect(client.createTask).toHaveBeenCalledWith('project-1', {
      title: spec.title,
      description: expect.stringContaining('Run this craftbook end to end'),
      craftbookId: 'sample-book',
      assignee: { kind: 'gezel', gezelId: 'gezel-1' },
      dispatchEntry: true,
    });
    // The runtime drives the steps — no freehand worker kickoff.
    expect(client.sendChatMessage).not.toHaveBeenCalled();
    expect(logs.some((line) => line.includes('created + dispatched fanout craftbook task'))).toBe(
      true,
    );
  });

  it('does not mirror workspace source fixtures into artifacts', async () => {
    const client = {
      listProjects: vi.fn().mockResolvedValue({ projects: [] }),
      createProject: vi.fn().mockResolvedValue({ id: 'project-1' }),
      writeProjectWorkspaceFile: vi.fn().mockResolvedValue({ ok: true }),
      writeProjectArtifact: vi.fn().mockResolvedValue({ ok: true }),
      createGezel: vi.fn().mockResolvedValue({ id: 'gezel-1' }),
      installToolset: vi.fn().mockResolvedValue({ ok: true }),
      listGezels: vi.fn(),
      addGezelToProject: vi.fn().mockResolvedValue({
        projectId: 'project-1',
        gezelIds: ['gezel-1'],
        added: true,
      }),
      sendChatMessage: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const scenario = craftbookScenarioFromSpec({
      ...directWorkerSpec(),
      setup: {
        ...directWorkerSpec().setup!,
        files: [
          { path: 'source/input.md', content: 'Workspace-only source.' },
          { path: 'data/input.csv', content: 'id,value\n1,2\n' },
          { path: 'artifact-note.md', content: 'Artifact fixture.', surface: 'artifact' },
        ],
      },
    });

    await scenario.setup?.({
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
    } as unknown as EvalContext);

    expect(client.writeProjectWorkspaceFile).toHaveBeenCalledTimes(2);
    expect(client.writeProjectWorkspaceFile).toHaveBeenCalledWith('project-1', {
      path: 'source/input.md',
      content: 'Workspace-only source.',
    });
    expect(client.writeProjectWorkspaceFile).toHaveBeenCalledWith('project-1', {
      path: 'data/input.csv',
      content: 'id,value\n1,2\n',
    });
    expect(client.writeProjectArtifact).toHaveBeenCalledTimes(1);
    expect(client.writeProjectArtifact).toHaveBeenCalledWith(
      'project-1',
      'artifact-note.md',
      'Artifact fixture.',
    );
    expect(client.installToolset).toHaveBeenCalledWith('builtin.workspace-fs-read', {
      scope: { kind: 'gezel', gezelId: 'gezel-1' },
    });
    expect(client.installToolset).toHaveBeenCalledWith('builtin.workspace-fs-write', {
      scope: { kind: 'gezel', gezelId: 'gezel-1' },
    });
  });

  it('installs the images toolset for the direct worker when success needs raster images', async () => {
    const client = {
      listProjects: vi.fn().mockResolvedValue({ projects: [] }),
      createProject: vi.fn().mockResolvedValue({ id: 'project-1' }),
      writeProjectWorkspaceFile: vi.fn().mockResolvedValue({ ok: true }),
      createGezel: vi.fn().mockResolvedValue({ id: 'gezel-1' }),
      installToolset: vi.fn().mockResolvedValue({ ok: true }),
      listGezels: vi.fn(),
      addGezelToProject: vi.fn().mockResolvedValue({
        projectId: 'project-1',
        gezelIds: ['gezel-1'],
        added: true,
      }),
      sendChatMessage: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const scenario = craftbookScenarioFromSpec({
      ...directWorkerSpec(),
      success: {
        summary: 'characters/pip holds 4+ references.',
        checks: [{ kind: 'fileCount', ext: ['png'], min: 4, dir: 'characters/pip' }],
        deliverables: [{ path: 'characters/pip/sheet.json', kind: 'json' }],
      },
    });

    await scenario.setup?.({
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
    } as unknown as EvalContext);

    expect(client.installToolset).toHaveBeenCalledWith('builtin.images', {
      scope: { kind: 'gezel', gezelId: 'gezel-1' },
    });
  });

  it('does not install the images toolset when no raster deliverable is required', async () => {
    const client = {
      listProjects: vi.fn().mockResolvedValue({ projects: [] }),
      createProject: vi.fn().mockResolvedValue({ id: 'project-1' }),
      writeProjectWorkspaceFile: vi.fn().mockResolvedValue({ ok: true }),
      createGezel: vi.fn().mockResolvedValue({ id: 'gezel-1' }),
      installToolset: vi.fn().mockResolvedValue({ ok: true }),
      listGezels: vi.fn(),
      addGezelToProject: vi.fn().mockResolvedValue({
        projectId: 'project-1',
        gezelIds: ['gezel-1'],
        added: true,
      }),
      sendChatMessage: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const scenario = craftbookScenarioFromSpec({
      ...directWorkerSpec(),
      success: {
        summary: 'workspace/index.html exists.',
        deliverables: [{ path: 'index.html', kind: 'html-page' }],
      },
    });

    await scenario.setup?.({
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
    } as unknown as EvalContext);

    const installedIds = (client.installToolset.mock.calls as Array<[string, unknown]>).map(
      ([id]) => id,
    );
    expect(installedIds).not.toContain('builtin.images');
  });

  it('installs mock-mcp toolsets for the project when mcp mocks are declared', async () => {
    const client = {
      listProjects: vi.fn().mockResolvedValue({ projects: [] }),
      createProject: vi.fn().mockResolvedValue({ id: 'project-1' }),
      writeProjectWorkspaceFile: vi.fn().mockResolvedValue({ ok: true }),
      createGezel: vi.fn().mockResolvedValue({ id: 'gezel-1' }),
      installToolset: vi.fn().mockResolvedValue({ ok: true }),
      listGezels: vi.fn(),
      addGezelToProject: vi.fn().mockResolvedValue({
        projectId: 'project-1',
        gezelIds: ['gezel-1'],
        added: true,
      }),
      sendChatMessage: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const mocksRuntime: MockServicesRuntime = {
      services: new Map(),
      caPem: '',
      seedEntries: () => [],
      projectGrants: () => ({ grantedCredentials: [], credentialAllowedOrigins: {} }),
      substitute: (text: string) => text,
      servicesMarkdown: () => '# mocks',
      servicesJson: () => '[]\n',
      mcpToolsetFiles: () => [],
      bindProject: vi.fn(),
      close: async () => {},
    };
    const scenario = craftbookScenarioFromSpec({
      ...directWorkerSpec(),
      mocks: [
        {
          kind: 'mcp',
          id: 'alerts',
          description: 'Fake alerting MCP',
          tools: [{ name: 'list_alerts', description: 'List the currently firing alerts' }],
        },
      ],
    });

    await scenario.setup?.({
      client,
      meesterId: 'meester',
      mocks: mocksRuntime,
      log: vi.fn(),
      logChanged: vi.fn(),
    } as unknown as EvalContext);

    expect(mocksRuntime.bindProject).toHaveBeenCalledWith('project-1');
    expect(client.installToolset).toHaveBeenCalledWith('mock-mcp-alerts', {
      scope: { kind: 'project', projectId: 'project-1' },
    });
  });

  it('requires seeded workspace inputs to be read before accepting a deliverable', async () => {
    const client = {
      listProjects: vi
        .fn()
        .mockResolvedValue({ projects: [{ id: 'project-1', name: 'Sample Project' }] }),
      fetchProjectWorkspaceBlob: vi.fn().mockResolvedValue(new Blob(['complete output'])),
      listChatSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'session-1',
            gezelId: 'worker',
            projectId: 'project-1',
            lastActivityAt: '2026-06-28T05:00:00.000Z',
          },
        ],
      }),
      getChatSession: vi.fn().mockResolvedValue({
        id: 'session-1',
        messages: [
          {
            toolCalls: [{ name: 'write_file', success: true, path: 'out.md' }],
          },
        ],
      }),
      listGezels: vi.fn().mockResolvedValue({
        gezels: [{ id: 'worker', role: 'Developer' }],
      }),
      listInflightTurns: vi.fn().mockResolvedValue({ inflight: [] }),
      messageGezel: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const scenario = craftbookScenarioFromSpec({
      ...directWorkerSpec(),
      setup: {
        ...directWorkerSpec().setup!,
        files: [{ path: 'source/input.md', content: 'Seeded facts.' }],
      },
      success: {
        summary: 'workspace/out.md exists.',
        deliverables: [{ path: 'out.md', kind: 'generic-file', minBytes: 10 }],
      },
    });

    const result = await scenario.successCheck({
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
      recordSniff: vi.fn(),
    } as unknown as EvalContext);

    expect(result).toEqual({ done: false });
    expect(client.messageGezel).toHaveBeenCalledWith(
      'worker',
      expect.objectContaining({
        fromGezelId: 'meester',
        projectId: 'project-1',
        text: expect.stringContaining('SOURCE_READ_REQUIRED'),
      }),
    );
    const body = client.messageGezel.mock.calls[0]?.[1];
    expect(body?.text).toContain('read_file({ path: "source/input.md" })');
    expect(body?.expectedDeliverable).toBeUndefined();
  });

  it('accepts a seeded-file deliverable once the source was read', async () => {
    const client = {
      listProjects: vi
        .fn()
        .mockResolvedValue({ projects: [{ id: 'project-1', name: 'Sample Project' }] }),
      fetchProjectWorkspaceBlob: vi.fn().mockResolvedValue(new Blob(['complete output'])),
      listChatSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'session-1',
            gezelId: 'worker',
            projectId: 'project-1',
            lastActivityAt: '2026-06-28T05:00:00.000Z',
          },
        ],
      }),
      getChatSession: vi.fn().mockResolvedValue({
        id: 'session-1',
        messages: [
          {
            toolCalls: [
              {
                name: 'read_file',
                success: true,
                path: 'source/input.md',
                argsFull: 'path: source/input.md',
              },
              { name: 'write_file', success: true, path: 'out.md' },
            ],
          },
        ],
      }),
    };
    const scenario = craftbookScenarioFromSpec({
      ...directWorkerSpec(),
      setup: {
        ...directWorkerSpec().setup!,
        files: [{ path: 'source/input.md', content: 'Seeded facts.' }],
      },
      success: {
        summary: 'workspace/out.md exists.',
        deliverables: [{ path: 'out.md', kind: 'generic-file', minBytes: 10 }],
      },
    });

    const result = await scenario.successCheck({
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
      recordSniff: vi.fn(),
    } as unknown as EvalContext);

    expect(result).toEqual({
      done: true,
      success: true,
      reason: 'craftbook-sample-book passed 2 deterministic craftbook checks',
    });
  });

  it('can grade task-note craftbook outputs from the invoked task', async () => {
    const client = {
      listProjects: vi
        .fn()
        .mockResolvedValue({ projects: [{ id: 'project-1', name: 'Sample Project' }] }),
      listProjectTasks: vi.fn().mockResolvedValue({
        tasks: [
          {
            projectId: 'project-1',
            num: 1,
            craftbook: { id: 'sample-book' },
            sourceCraftbookIds: [{ catalogId: 'sample-book' }],
          },
        ],
      }),
      listTaskNotes: vi.fn().mockResolvedValue({
        notes: [
          {
            text: 'Symptom: pagination skips page-boundary records.\nRoot cause: decodeCursor resumes one item too far.\nProposed fix: remove the + 1 from the cursor start calculation.',
          },
        ],
      }),
    };
    const scenario = craftbookScenarioFromSpec({
      ...directWorkerSpec(),
      success: {
        summary: 'Task notes capture the investigation.',
        taskNotes: {
          minBytes: 80,
          requireCraftbookTask: true,
          checks: [
            { kind: 'contains', file: 'task-notes.md', pattern: 'Root cause', flags: 'i' },
            { kind: 'contains', file: 'task-notes.md', pattern: 'Proposed fix', flags: 'i' },
          ],
        },
      },
    });

    const result = await scenario.successCheck({
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
      recordSniff: vi.fn(),
    } as unknown as EvalContext);

    expect(result).toEqual({
      done: true,
      success: true,
      reason: 'craftbook-sample-book passed 3 deterministic craftbook checks',
    });
    expect(client.listTaskNotes).toHaveBeenCalledWith('project-1', 1);
  });

  it('can grade task-note craftbook outputs from workspace note aliases', async () => {
    const client = {
      listProjects: vi
        .fn()
        .mockResolvedValue({ projects: [{ id: 'project-1', name: 'Sample Project' }] }),
      listProjectTasks: vi.fn().mockResolvedValue({ tasks: [] }),
      fetchProjectWorkspaceBlob: vi
        .fn()
        .mockImplementation(async (_projectId: string, path: string) => {
          if (path !== 'task_notes.md') throw new Error('not found');
          return new Blob([
            [
              'Symptom: pagination skips page-boundary records.',
              'Minimal repro: run accept.mjs with limit 3.',
              'Root cause: decodeCursor is advanced by + 1.',
              'Proposed fix: remove the extra increment.',
              'Regression test: npm run accept.',
            ].join('\n'),
          ]);
        }),
    };
    const scenario = craftbookScenarioFromSpec({
      ...directWorkerSpec(),
      success: {
        summary: 'Task notes capture the investigation.',
        taskNotes: {
          minBytes: 120,
          checks: [
            { kind: 'contains', file: 'task-notes.md', pattern: 'Root cause', flags: 'i' },
            { kind: 'contains', file: 'task-notes.md', pattern: '\\+\\s*1', flags: 'i' },
            { kind: 'contains', file: 'task-notes.md', pattern: 'Regression test', flags: 'i' },
          ],
        },
      },
    });

    const result = await scenario.successCheck({
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
      recordSniff: vi.fn(),
    } as unknown as EvalContext);

    expect(result).toEqual({
      done: true,
      success: true,
      reason: 'craftbook-sample-book passed 4 deterministic craftbook checks',
    });
    expect(client.fetchProjectWorkspaceBlob).toHaveBeenCalledWith('project-1', 'task_notes.md');
  });

  it('targets task-note repair instead of the primary deliverable when note gates fail', async () => {
    const files = new Map([['brief.md', '# Brief\n\nA complete-enough brief.']]);
    const client = {
      listProjects: vi
        .fn()
        .mockResolvedValue({ projects: [{ id: 'project-1', name: 'Sample Project' }] }),
      fetchProjectWorkspaceBlob: vi
        .fn()
        .mockImplementation(async (_projectId: string, path: string) => {
          const content = files.get(path);
          if (content === undefined) throw new Error('not found');
          return new Blob([content]);
        }),
      listProjectTasks: vi.fn().mockResolvedValue({ tasks: [] }),
      listChatSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'session-writer',
            gezelId: 'writer-1',
            projectId: 'project-1',
            lastActivityAt: '2026-06-28T05:00:00Z',
          },
        ],
      }),
      listGezels: vi.fn().mockResolvedValue({ gezels: [{ id: 'writer-1', role: 'Writer' }] }),
      messageGezel: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const scenario = craftbookScenarioFromSpec({
      ...directWorkerSpec(),
      success: {
        summary: 'workspace/brief.md and task notes exist.',
        deliverables: [{ path: 'brief.md', kind: 'markdown-report', minBytes: 10 }],
        taskNotes: {
          minBytes: 80,
          checks: [{ kind: 'contains', file: 'task-notes.md', pattern: 'criteria', flags: 'i' }],
        },
      },
    });

    const result = await scenario.successCheck({
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
      recordSniff: vi.fn(),
    } as unknown as EvalContext);

    expect(result).toEqual({ done: false });
    expect(client.messageGezel).toHaveBeenCalledWith('writer-1', {
      fromGezelId: 'meester',
      text: expect.stringContaining('task-notes.md'),
      expectedDeliverable: { kind: 'file', filePath: 'task-notes.md' },
      projectId: 'project-1',
    });
    expect(client.messageGezel.mock.calls[0]![1].text).not.toContain('brief.md is');
  });

  it('can grade task-native craftbook outputs from a draft task graph', async () => {
    const authoringTask = {
      projectId: 'project-1',
      num: 1,
      ref: 'T-1',
      title: 'Author plan',
      description: 'Run the plan craftbook',
      status: 'active',
      craftbook: { id: 'plan', steps: [{ id: 'frame', name: 'Frame' }] },
      sourceCraftbookIds: [{ catalogId: 'plan' }],
      craftbookParams: { draftRef: 'T-2' },
    };
    const draftTask = {
      projectId: 'project-1',
      num: 2,
      ref: 'T-2',
      title: 'Draft build plan',
      description:
        'Build a small workshop checklist timer with a complete HTML deliverable, acceptance criteria, and verification.',
      status: 'draft',
      outcomes: [
        { id: 'outcome-1', text: 'An index.html checklist timer is created.' },
        { id: 'outcome-2', text: 'The timer has start, pause, and reset controls.' },
        { id: 'outcome-3', text: 'The final step verifies every outcome with evidence.' },
      ],
      craftbook: {
        id: 'draft-plan',
        steps: [
          { id: 'build', name: 'Build index.html', gate: { at: 'completion', checks: [] } },
          {
            id: 'verify',
            name: 'Verify outcomes',
            prompt: 'Verify each outcome with evidence.',
            terminal: true,
          },
        ],
      },
    };
    const client = {
      listProjects: vi
        .fn()
        .mockResolvedValue({ projects: [{ id: 'project-1', name: 'Sample Project' }] }),
      listProjectTasks: vi.fn().mockResolvedValue({ tasks: [authoringTask] }),
      getTaskByRef: vi.fn().mockResolvedValue(draftTask),
    };
    const scenario = craftbookScenarioFromSpec({
      ...directWorkerSpec(),
      craftbookId: 'plan',
      success: {
        summary: 'A draft task plan is authored.',
        taskGraph: {
          requireCraftbookTask: true,
          requireDraftRef: true,
          draft: {
            status: 'draft',
            minDescriptionBytes: 80,
            minOutcomes: 3,
            minSteps: 2,
            requireTerminalVerification: true,
            requireGatedBuildSteps: true,
          },
          checks: [{ kind: 'contains', file: 'task-graph.md', pattern: 'index.html' }],
        },
      },
    });

    const result = await scenario.successCheck({
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
      recordSniff: vi.fn(),
    } as unknown as EvalContext);

    expect(result).toEqual({
      done: true,
      success: true,
      reason: 'craftbook-sample-book passed 2 deterministic craftbook checks',
    });
    expect(client.getTaskByRef).toHaveBeenCalledWith('T-2');
  });

  it('pins task-graph repair feedback to the authoring task assignee', async () => {
    const authoringTask = {
      projectId: 'project-1',
      num: 1,
      ref: 'T-1',
      title: 'Author plan',
      description: 'Run the plan craftbook',
      status: 'active',
      assignee: { kind: 'gezel', gezelId: 'planner-1' },
      craftbook: { id: 'plan', steps: [{ id: 'frame', name: 'Frame' }] },
      sourceCraftbookIds: [{ catalogId: 'plan' }],
      craftbookParams: { draftRef: 'T-2' },
    };
    const draftTask = {
      projectId: 'project-1',
      num: 2,
      ref: 'T-2',
      title: 'Draft build plan',
      description:
        'Build a small workshop checklist timer with a complete HTML deliverable, acceptance criteria, and verification.',
      status: 'draft',
      outcomes: [
        { id: 'outcome-1', text: 'An index.html checklist timer is created.' },
        { id: 'outcome-2', text: 'The timer has controls.' },
        { id: 'outcome-3', text: 'The final step verifies every outcome.' },
      ],
      craftbook: {
        id: 'draft-plan',
        steps: [{ id: 'implement', name: 'Implement' }],
      },
    };
    const client = {
      listProjects: vi
        .fn()
        .mockResolvedValue({ projects: [{ id: 'project-1', name: 'Sample Project' }] }),
      listProjectTasks: vi.fn().mockResolvedValue({ tasks: [authoringTask] }),
      getTaskByRef: vi.fn().mockResolvedValue(draftTask),
      listChatSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'session-helper',
            gezelId: 'helper-1',
            projectId: 'project-1',
            lastActivityAt: '2026-06-28T05:05:00Z',
          },
          {
            id: 'session-planner',
            gezelId: 'planner-1',
            projectId: 'project-1',
            lastActivityAt: '2026-06-28T05:00:00Z',
          },
        ],
      }),
      listGezels: vi.fn().mockResolvedValue({
        gezels: [
          { id: 'helper-1', role: 'Developer' },
          { id: 'planner-1', role: 'Planner' },
        ],
      }),
      messageGezel: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const scenario = craftbookScenarioFromSpec({
      ...directWorkerSpec(),
      craftbookId: 'plan',
      success: {
        summary: 'A draft task plan is authored.',
        taskGraph: {
          requireCraftbookTask: true,
          requireDraftRef: true,
          draft: {
            status: 'draft',
            minDescriptionBytes: 80,
            minOutcomes: 3,
            minSteps: 3,
            requireTerminalVerification: true,
            requireGatedBuildSteps: true,
          },
        },
      },
    });

    const result = await scenario.successCheck({
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
      recordSniff: vi.fn(),
    } as unknown as EvalContext);

    expect(result).toEqual({ done: false });
    expect(client.messageGezel).toHaveBeenCalledWith(
      'planner-1',
      expect.objectContaining({
        projectId: 'project-1',
        text: expect.stringContaining('draft T-2 has 1 steps; expected at least 3'),
      }),
    );
    const messageText = client.messageGezel.mock.calls[0]![1].text;
    expect(messageText).toContain('do not write, patch, or create a file named `task-graph.md`');
    expect(messageText).toContain('set_step_deliverable');
    expect(messageText).toContain('add_verification_step');
  });

  it('fails when a structured task requirement is not met even if virtual text checks pass', async () => {
    const client = {
      listProjects: vi
        .fn()
        .mockResolvedValue({ projects: [{ id: 'project-1', name: 'Sample Project' }] }),
      listProjectTasks: vi.fn().mockResolvedValue({
        tasks: [
          {
            projectId: 'project-1',
            num: 1,
            ref: 'T-1',
            title: 'Unrelated task',
            status: 'active',
            craftbook: { id: 'other-book', steps: [{ id: 'x', name: 'X' }] },
          },
        ],
      }),
      listChatSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    };
    const scenario = craftbookScenarioFromSpec({
      ...directWorkerSpec(),
      success: {
        summary: 'A craftbook task must exist.',
        taskGraph: {
          requireCraftbookTask: true,
        },
      },
    });

    const result = await scenario.successCheck({
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
      recordSniff: vi.fn(),
    } as unknown as EvalContext);

    expect(result).toEqual({ done: false });
  });

  it('does not post immediate sniff feedback before a file deliverable exists', async () => {
    const client = {
      listProjects: vi
        .fn()
        .mockResolvedValue({ projects: [{ id: 'project-1', name: 'Sample Project' }] }),
      fetchProjectWorkspaceBlob: vi.fn().mockRejectedValue(new Error('not found')),
    };
    const scenario = craftbookScenarioFromSpec({
      ...directWorkerSpec(),
      success: {
        summary: 'workspace/index.html exists.',
        deliverables: [{ path: 'index.html', kind: 'html-page', minBytes: 800 }],
      },
    });

    const result = await scenario.successCheck({
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
      recordSniff: vi.fn(),
    } as unknown as EvalContext);

    expect(result).toEqual({ done: false });
    expect(client.fetchProjectWorkspaceBlob).toHaveBeenCalledWith('project-1', 'index.html');
  });

  it('targets feedback at the failing secondary deliverable', async () => {
    const files = new Map([
      ['report.md', '# Report\n\nThis report is long enough and has a heading.'],
      ['data/audit.json', '{"summary":{"total_records":7}}'],
    ]);
    const client = {
      listProjects: vi
        .fn()
        .mockResolvedValue({ projects: [{ id: 'project-1', name: 'Sample Project' }] }),
      fetchProjectWorkspaceBlob: vi
        .fn()
        .mockImplementation(async (_projectId: string, path: string) => {
          const content = files.get(path);
          if (content === undefined) throw new Error('not found');
          return new Blob([content]);
        }),
      listChatSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'session-writer',
            gezelId: 'writer-1',
            projectId: 'project-1',
            lastActivityAt: '2026-06-28T05:00:00Z',
          },
        ],
      }),
      listGezels: vi.fn().mockResolvedValue({ gezels: [{ id: 'writer-1', role: 'Analyst' }] }),
      messageGezel: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const scenario = craftbookScenarioFromSpec({
      ...directWorkerSpec(),
      success: {
        summary: 'workspace/report.md and workspace/data/audit.json exist.',
        deliverables: [
          { path: 'report.md', kind: 'markdown-report', minBytes: 10 },
          {
            path: 'data/audit.json',
            kind: 'json',
            minBytes: 2,
            checks: [
              {
                kind: 'jsonPathEquals',
                file: 'data/audit.json',
                path: 'summary.total_records',
                value: 6,
                label: 'use the seeded CSV row count',
              },
            ],
          },
        ],
      },
    });

    const result = await scenario.successCheck({
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
      recordSniff: vi.fn(),
    } as unknown as EvalContext);

    expect(result).toEqual({ done: false });
    expect(client.messageGezel).toHaveBeenCalledWith('writer-1', {
      fromGezelId: 'meester',
      text: expect.stringContaining('data/audit.json summary.total_records should equal 6'),
      expectedDeliverable: { kind: 'file', filePath: 'data/audit.json' },
      projectId: 'project-1',
    });
  });

  it('targets secondary semantic failures before primary byte-count failures', async () => {
    const files = new Map([
      ['report.md', '# Report\n\nShort but structurally fine.'],
      ['data/audit.json', '{"summary":{"total_records":7}}'],
    ]);
    const client = {
      listProjects: vi
        .fn()
        .mockResolvedValue({ projects: [{ id: 'project-1', name: 'Sample Project' }] }),
      fetchProjectWorkspaceBlob: vi
        .fn()
        .mockImplementation(async (_projectId: string, path: string) => {
          const content = files.get(path);
          if (content === undefined) throw new Error('not found');
          return new Blob([content]);
        }),
      listChatSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'session-writer',
            gezelId: 'writer-1',
            projectId: 'project-1',
            lastActivityAt: '2026-06-28T05:00:00Z',
          },
        ],
      }),
      listGezels: vi.fn().mockResolvedValue({ gezels: [{ id: 'writer-1', role: 'Analyst' }] }),
      messageGezel: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const scenario = craftbookScenarioFromSpec({
      ...directWorkerSpec(),
      success: {
        summary: 'workspace/report.md and workspace/data/audit.json exist.',
        deliverables: [
          { path: 'report.md', kind: 'markdown-report', minBytes: 1000 },
          {
            path: 'data/audit.json',
            kind: 'json',
            minBytes: 2,
            checks: [
              {
                kind: 'jsonPathEquals',
                file: 'data/audit.json',
                path: 'summary.total_records',
                value: 6,
                label: 'use the seeded CSV row count',
              },
            ],
          },
        ],
      },
    });

    const result = await scenario.successCheck({
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
      recordSniff: vi.fn(),
    } as unknown as EvalContext);

    expect(result).toEqual({ done: false });
    expect(client.messageGezel).toHaveBeenCalledWith('writer-1', {
      fromGezelId: 'meester',
      text: expect.stringContaining('data/audit.json summary.total_records should equal 6'),
      expectedDeliverable: { kind: 'file', filePath: 'data/audit.json' },
      projectId: 'project-1',
    });
    const messageText = client.messageGezel.mock.calls[0]![1].text;
    expect(messageText).not.toContain('report.md is');
  });

  it('targets an empty required implementation before secondary contract failures', async () => {
    const files = new Map([
      ['server.mjs', ''],
      [
        'contract-test.mjs',
        "import { createBookstoreServer } from './server.mjs';\ncreateBookstoreServer();\n",
      ],
    ]);
    const client = {
      listProjects: vi
        .fn()
        .mockResolvedValue({ projects: [{ id: 'project-1', name: 'Sample Project' }] }),
      fetchProjectWorkspaceBlob: vi
        .fn()
        .mockImplementation(async (_projectId: string, path: string) => {
          const content = files.get(path);
          if (content === undefined) throw new Error('not found');
          return new Blob([content]);
        }),
      listProjectWorkspace: vi.fn().mockResolvedValue({
        files: [...files.keys()].map((path) => ({ path, isDirectory: false })),
      }),
      listChatSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'session-developer',
            gezelId: 'developer-1',
            projectId: 'project-1',
            lastActivityAt: '2026-06-28T05:00:00Z',
          },
        ],
      }),
      getChatSession: vi.fn().mockResolvedValue({
        id: 'session-developer',
        messages: [
          {
            toolCalls: [{ name: 'write_file', success: true, path: 'contract-test.mjs' }],
          },
        ],
      }),
      listGezels: vi.fn().mockResolvedValue({ gezels: [{ id: 'developer-1', role: 'Developer' }] }),
      messageGezel: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const scenario = craftbookScenarioFromSpec({
      ...directWorkerSpec(),
      setup: {
        ...directWorkerSpec().setup!,
        files: [{ path: 'source/api-brief.md', content: 'Seeded API facts.' }],
      },
      success: {
        summary: 'workspace/server.mjs and workspace/contract-test.mjs exist.',
        deliverables: [
          {
            path: 'server.mjs',
            kind: 'code-module',
            minBytes: 2200,
          },
          {
            path: 'contract-test.mjs',
            kind: 'code-with-tests',
            minBytes: 2,
            checks: [
              { kind: 'contains', file: 'contract-test.mjs', pattern: 'limit=2|hasMore' },
              { kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 },
            ],
          },
        ],
      },
    });

    const result = await scenario.successCheck({
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
      recordSniff: vi.fn(),
    } as unknown as EvalContext);

    expect(result).toEqual({ done: false });
    expect(client.messageGezel).toHaveBeenCalledWith('developer-1', {
      fromGezelId: 'meester',
      text: expect.stringContaining('server.mjs is 0 bytes, need ≥ 2200'),
      expectedDeliverable: { kind: 'file', filePath: 'server.mjs' },
      projectId: 'project-1',
    });
    expect(client.messageGezel.mock.calls[0]![1].text).not.toContain('SOURCE_READ_REQUIRED');
  });

  it('targets executable contract failures before ordinary semantic misses', async () => {
    const files = new Map([
      ['openapi.yaml', 'openapi: 3.1.0\ninfo:\n  title: Test\n'],
      ['contract-test.mjs', "throw new Error('runtime contract failed');\n"],
    ]);
    const client = {
      listProjects: vi
        .fn()
        .mockResolvedValue({ projects: [{ id: 'project-1', name: 'Sample Project' }] }),
      fetchProjectWorkspaceBlob: vi
        .fn()
        .mockImplementation(async (_projectId: string, path: string) => {
          const content = files.get(path);
          if (content === undefined) throw new Error('not found');
          return new Blob([content]);
        }),
      listProjectWorkspace: vi.fn().mockResolvedValue({
        files: [...files.keys()].map((path) => ({ path, isDirectory: false })),
      }),
      listChatSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'session-developer',
            gezelId: 'developer-1',
            projectId: 'project-1',
            lastActivityAt: '2026-06-28T05:00:00Z',
          },
        ],
      }),
      listGezels: vi.fn().mockResolvedValue({ gezels: [{ id: 'developer-1', role: 'Developer' }] }),
      messageGezel: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const scenario = craftbookScenarioFromSpec({
      ...directWorkerSpec(),
      success: {
        summary: 'workspace/openapi.yaml and workspace/contract-test.mjs exist.',
        deliverables: [
          {
            path: 'openapi.yaml',
            kind: 'yaml-spec',
            minBytes: 2,
            checks: [
              {
                kind: 'contains',
                file: 'openapi.yaml',
                pattern: 'ErrorEnvelope',
              },
            ],
          },
          {
            path: 'contract-test.mjs',
            kind: 'code-with-tests',
            minBytes: 2,
            checks: [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
          },
        ],
      },
    });

    const result = await scenario.successCheck({
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
      recordSniff: vi.fn(),
    } as unknown as EvalContext);

    expect(result).toEqual({ done: false });
    expect(client.messageGezel).toHaveBeenCalledWith('developer-1', {
      fromGezelId: 'meester',
      text: expect.stringContaining('contract-test.mjs did not pass when run with node'),
      expectedDeliverable: { kind: 'file', filePath: 'contract-test.mjs' },
      projectId: 'project-1',
    });
  });

  it('targets implementation semantic failures before dependent contract runtime failures', async () => {
    const files = new Map([
      ['server.mjs', 'export function createBookstoreServer() { return {}; }\n'],
      [
        'contract-test.mjs',
        "throw new Error('AssertionError: POST /books created body title mismatch');\n",
      ],
    ]);
    const client = {
      listProjects: vi
        .fn()
        .mockResolvedValue({ projects: [{ id: 'project-1', name: 'Sample Project' }] }),
      fetchProjectWorkspaceBlob: vi
        .fn()
        .mockImplementation(async (_projectId: string, path: string) => {
          const content = files.get(path);
          if (content === undefined) throw new Error('not found');
          return new Blob([content]);
        }),
      listProjectWorkspace: vi.fn().mockResolvedValue({
        files: [...files.keys()].map((path) => ({ path, isDirectory: false })),
      }),
      listChatSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'session-developer',
            gezelId: 'developer-1',
            projectId: 'project-1',
            lastActivityAt: '2026-06-28T05:00:00Z',
          },
        ],
      }),
      listGezels: vi.fn().mockResolvedValue({ gezels: [{ id: 'developer-1', role: 'Developer' }] }),
      messageGezel: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const scenario = craftbookScenarioFromSpec({
      ...directWorkerSpec(),
      success: {
        summary: 'workspace/server.mjs and workspace/contract-test.mjs exist.',
        deliverables: [
          {
            path: 'server.mjs',
            kind: 'code-module',
            minBytes: 2,
            checks: [
              {
                kind: 'contains',
                file: 'server.mjs',
                pattern: 'Bearer eval-token',
                label: 'enforce exact Authorization: Bearer eval-token on POST /books',
              },
            ],
          },
          {
            path: 'contract-test.mjs',
            kind: 'code-with-tests',
            minBytes: 2,
            checks: [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
          },
        ],
      },
    });

    const result = await scenario.successCheck({
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
      recordSniff: vi.fn(),
    } as unknown as EvalContext);

    expect(result).toEqual({ done: false });
    expect(client.messageGezel).toHaveBeenCalledWith('developer-1', {
      fromGezelId: 'meester',
      text: expect.stringContaining('server.mjs is missing required content'),
      expectedDeliverable: { kind: 'file', filePath: 'server.mjs' },
      projectId: 'project-1',
    });
  });

  it('targets implementation modules for contract assertion failures', async () => {
    const files = new Map([
      ['server.mjs', 'export function createBookstoreServer() { return { ok: true }; }\n'],
      [
        'contract-test.mjs',
        "throw new Error('AssertionError [ERR_ASSERTION]: Created book title mismatch\\n+ actual - expected\\n+ undefined\\n- New Test Book');\n",
      ],
    ]);
    const client = {
      listProjects: vi
        .fn()
        .mockResolvedValue({ projects: [{ id: 'project-1', name: 'Sample Project' }] }),
      fetchProjectWorkspaceBlob: vi
        .fn()
        .mockImplementation(async (_projectId: string, path: string) => {
          const content = files.get(path);
          if (content === undefined) throw new Error('not found');
          return new Blob([content]);
        }),
      listProjectWorkspace: vi.fn().mockResolvedValue({
        files: [...files.keys()].map((path) => ({ path, isDirectory: false })),
      }),
      listChatSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'session-developer',
            gezelId: 'developer-1',
            projectId: 'project-1',
            lastActivityAt: '2026-06-28T05:00:00Z',
          },
        ],
      }),
      listGezels: vi.fn().mockResolvedValue({ gezels: [{ id: 'developer-1', role: 'Developer' }] }),
      messageGezel: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const scenario = craftbookScenarioFromSpec({
      ...directWorkerSpec(),
      success: {
        summary: 'workspace/server.mjs and workspace/contract-test.mjs exist.',
        deliverables: [
          {
            path: 'server.mjs',
            kind: 'code-module',
            minBytes: 2,
          },
          {
            path: 'contract-test.mjs',
            kind: 'code-with-tests',
            minBytes: 2,
            checks: [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
          },
        ],
      },
    });

    const result = await scenario.successCheck({
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
      recordSniff: vi.fn(),
    } as unknown as EvalContext);

    expect(result).toEqual({ done: false });
    expect(client.messageGezel).toHaveBeenCalledWith('developer-1', {
      fromGezelId: 'meester',
      text: expect.stringContaining('Created book title mismatch'),
      expectedDeliverable: { kind: 'file', filePath: 'server.mjs' },
      projectId: 'project-1',
    });
  });

  it('targets imported code when an executable contract fails inside that dependency', async () => {
    const files = new Map([
      [
        'server.mjs',
        "import { createBookstoreServer } from './server.mjs';\nexport function createBookstoreServer() {}\n",
      ],
      [
        'contract-test.mjs',
        "import { createBookstoreServer } from './server.mjs';\ncreateBookstoreServer();\n",
      ],
    ]);
    const client = {
      listProjects: vi
        .fn()
        .mockResolvedValue({ projects: [{ id: 'project-1', name: 'Sample Project' }] }),
      fetchProjectWorkspaceBlob: vi
        .fn()
        .mockImplementation(async (_projectId: string, path: string) => {
          const content = files.get(path);
          if (content === undefined) throw new Error('not found');
          return new Blob([content]);
        }),
      listProjectWorkspace: vi.fn().mockResolvedValue({
        files: [...files.keys()].map((path) => ({ path, isDirectory: false })),
      }),
      listChatSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'session-developer',
            gezelId: 'developer-1',
            projectId: 'project-1',
            lastActivityAt: '2026-06-28T05:00:00Z',
          },
        ],
      }),
      listGezels: vi.fn().mockResolvedValue({ gezels: [{ id: 'developer-1', role: 'Developer' }] }),
      messageGezel: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const scenario = craftbookScenarioFromSpec({
      ...directWorkerSpec(),
      success: {
        summary: 'workspace/server.mjs and workspace/contract-test.mjs exist.',
        deliverables: [
          {
            path: 'server.mjs',
            kind: 'code-module',
            minBytes: 2,
          },
          {
            path: 'contract-test.mjs',
            kind: 'code-with-tests',
            minBytes: 2,
            checks: [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
          },
        ],
      },
    });

    const result = await scenario.successCheck({
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
      recordSniff: vi.fn(),
    } as unknown as EvalContext);

    expect(result).toEqual({ done: false });
    expect(client.messageGezel).toHaveBeenCalledWith('developer-1', {
      fromGezelId: 'meester',
      text: expect.stringContaining('server.mjs'),
      expectedDeliverable: { kind: 'file', filePath: 'server.mjs' },
      projectId: 'project-1',
    });
  });

  it('prioritizes semantic repair failures before mild byte-count failures', async () => {
    const content = `# Audit

Claim [A] is supported.

${'Detailed supporting analysis.\n'.repeat(22)}`;
    const client = {
      listProjects: vi
        .fn()
        .mockResolvedValue({ projects: [{ id: 'project-1', name: 'Sample Project' }] }),
      fetchProjectWorkspaceBlob: vi.fn().mockResolvedValue(new Blob([content])),
      listChatSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'session-reviewer',
            gezelId: 'reviewer-1',
            projectId: 'project-1',
            lastActivityAt: '2026-06-28T05:00:00Z',
          },
        ],
      }),
      listGezels: vi.fn().mockResolvedValue({ gezels: [{ id: 'reviewer-1', role: 'Reviewer' }] }),
      messageGezel: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const recordSniff = vi.fn();
    const scenario = craftbookScenarioFromSpec({
      ...directWorkerSpec(),
      success: {
        summary: 'workspace/audit.md contains the citation audit.',
        deliverables: [
          {
            path: 'audit.md',
            kind: 'markdown-report',
            minBytes: 800,
            checks: [
              {
                kind: 'contains',
                file: 'audit.md',
                pattern: 'Finance[\\s\\S]{0,500}Uncited-Claim',
                flags: 'i',
              },
              { kind: 'contains', file: 'audit.md', pattern: 'fix|correction', flags: 'i' },
            ],
          },
        ],
      },
    });

    const result = await scenario.successCheck({
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
      recordSniff,
    } as unknown as EvalContext);

    expect(result).toEqual({ done: false });
    expect(recordSniff).toHaveBeenCalledWith({
      key: 'craftbook-sample-book',
      score: expect.any(Number),
      bytes: content.length,
      failReason: expect.stringContaining('Finance'),
    });
    expect(client.messageGezel).toHaveBeenCalledWith('reviewer-1', {
      fromGezelId: 'meester',
      text: expect.stringContaining('Specific failure: audit.md is missing required content'),
      expectedDeliverable: { kind: 'file', filePath: 'audit.md' },
      projectId: 'project-1',
    });
    const messageText = client.messageGezel.mock.calls[0]![1].text;
    expect(messageText.indexOf('Finance')).toBeLessThan(messageText.indexOf('bytes, need'));
  });

  it('prioritizes severe byte-count regressions before executable and semantic failures', async () => {
    const files = new Map([['contract-test.mjs', 'stub\n']]);
    const client = {
      listProjects: vi
        .fn()
        .mockResolvedValue({ projects: [{ id: 'project-1', name: 'Sample Project' }] }),
      fetchProjectWorkspaceBlob: vi
        .fn()
        .mockImplementation(async (_projectId: string, path: string) => {
          const content = files.get(path);
          if (content === undefined) throw new Error('not found');
          return new Blob([content]);
        }),
      listProjectWorkspace: vi.fn().mockResolvedValue({
        files: [...files.keys()].map((path) => ({ path, isDirectory: false })),
      }),
      listChatSessions: vi.fn().mockResolvedValue({
        sessions: [
          {
            id: 'session-developer',
            gezelId: 'developer-1',
            projectId: 'project-1',
            lastActivityAt: '2026-06-28T05:00:00Z',
          },
        ],
      }),
      listGezels: vi.fn().mockResolvedValue({ gezels: [{ id: 'developer-1', role: 'Developer' }] }),
      messageGezel: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const scenario = craftbookScenarioFromSpec({
      ...directWorkerSpec(),
      success: {
        summary: 'workspace/contract-test.mjs exists and runs.',
        deliverables: [
          {
            path: 'contract-test.mjs',
            kind: 'code-with-tests',
            minBytes: 1500,
            checks: [
              {
                kind: 'contains',
                file: 'contract-test.mjs',
                pattern: 'node:assert/strict',
              },
              { kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 },
            ],
          },
        ],
      },
    });

    const result = await scenario.successCheck({
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
      recordSniff: vi.fn(),
    } as unknown as EvalContext);

    expect(result).toEqual({ done: false });
    const messageText = client.messageGezel.mock.calls[0]![1].text;
    expect(messageText).toContain('contract-test.mjs is 5 bytes, need ≥ 1500');
    expect(messageText.indexOf('bytes, need')).toBeLessThan(messageText.indexOf('node:assert'));
    expect(messageText.indexOf('bytes, need')).toBeLessThan(
      messageText.indexOf('did not pass when run with node'),
    );
  });

  it('fails as model-stuck when repair feedback produces chat activity but no file change', async () => {
    const startedAt = Date.parse('2026-06-28T05:00:00Z');
    let now = startedAt;
    let sessionActivityAt = '2026-06-28T05:00:00Z';
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const content = '# Release\n\nToo short.\n';
    const client = {
      listProjects: vi
        .fn()
        .mockResolvedValue({ projects: [{ id: 'project-1', name: 'Sample Project' }] }),
      fetchProjectWorkspaceBlob: vi.fn().mockResolvedValue(new Blob([content])),
      listChatSessions: vi.fn().mockImplementation(() =>
        Promise.resolve({
          sessions: [
            {
              id: 'session-writer',
              gezelId: 'writer-1',
              projectId: 'project-1',
              lastActivityAt: sessionActivityAt,
            },
          ],
        }),
      ),
      listGezels: vi.fn().mockResolvedValue({ gezels: [{ id: 'writer-1', role: 'Writer' }] }),
      listInflightTurns: vi.fn().mockResolvedValue({ inflight: [] }),
      messageGezel: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const scenario = craftbookScenarioFromSpec({
      ...directWorkerSpec(),
      success: {
        summary: 'workspace/press-release.md is substantial.',
        deliverables: [{ path: 'press-release.md', kind: 'markdown-doc', minBytes: 800 }],
      },
    });
    const recordSniff = vi.fn();
    const ctx = {
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
      recordSniff,
    } as unknown as EvalContext;

    try {
      await expect(scenario.successCheck(ctx)).resolves.toEqual({ done: false });
      expect(recordSniff).toHaveBeenLastCalledWith({
        key: 'craftbook-sample-book',
        score: 0,
        bytes: content.length,
        failReason: expect.stringContaining('press-release.md'),
      });
      expect(client.messageGezel).toHaveBeenCalledTimes(1);

      now = startedAt + 30_000;
      await expect(scenario.successCheck(ctx)).resolves.toEqual({ done: false });

      now = startedAt + 65_000;
      sessionActivityAt = '2026-06-28T05:01:05Z';
      await expect(scenario.successCheck(ctx)).resolves.toEqual({
        done: true,
        success: false,
        failureMode: 'model-stuck',
        reason: expect.stringContaining('stale no-write repair loop'),
      });
      expect(client.messageGezel).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('fails as model-stuck when repair rewrites keep the same failing gate', async () => {
    const startedAt = Date.parse('2026-06-28T05:00:00Z');
    let now = startedAt;
    let sessionActivityAt = '2026-06-28T05:00:00Z';
    let content = '# Audit\n\nClaim [E] should not be here.\n';
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const client = {
      listProjects: vi
        .fn()
        .mockResolvedValue({ projects: [{ id: 'project-1', name: 'Sample Project' }] }),
      fetchProjectWorkspaceBlob: vi
        .fn()
        .mockImplementation(() => Promise.resolve(new Blob([content]))),
      listChatSessions: vi.fn().mockImplementation(() =>
        Promise.resolve({
          sessions: [
            {
              id: 'session-writer',
              gezelId: 'writer-1',
              projectId: 'project-1',
              lastActivityAt: sessionActivityAt,
            },
          ],
        }),
      ),
      listGezels: vi.fn().mockResolvedValue({ gezels: [{ id: 'writer-1', role: 'Reviewer' }] }),
      listInflightTurns: vi.fn().mockResolvedValue({ inflight: [] }),
      messageGezel: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const scenario = craftbookScenarioFromSpec({
      ...directWorkerSpec(),
      success: {
        summary: 'workspace/audit.md contains only seeded claims.',
        deliverables: [
          {
            path: 'audit.md',
            kind: 'markdown-report',
            minBytes: 10,
            checks: [
              {
                kind: 'notContains',
                file: 'audit.md',
                pattern: 'Claim \\[E\\]',
                flags: 'i',
                label: 'do not invent audit claims',
              },
            ],
          },
        ],
      },
    });
    const ctx = {
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
      recordSniff: vi.fn(),
    } as unknown as EvalContext;

    try {
      await expect(scenario.successCheck(ctx)).resolves.toEqual({ done: false });

      now = startedAt + 30_000;
      content = '# Audit\n\nClaim [E] should still not be here.\n';
      await expect(scenario.successCheck(ctx)).resolves.toEqual({ done: false });

      now = startedAt + 65_000;
      sessionActivityAt = '2026-06-28T05:01:05Z';
      content = '# Audit\n\nClaim [E] remains despite another rewrite.\n';
      await expect(scenario.successCheck(ctx)).resolves.toEqual({
        done: true,
        success: false,
        failureMode: 'model-stuck',
        reason: expect.stringContaining('was rewritten 2 time(s) but kept failing the same gate'),
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not fail a stale file while the target project has a young inflight turn', async () => {
    const startedAt = Date.parse('2026-06-28T05:00:00Z');
    let now = startedAt;
    let sessionActivityAt = '2026-06-28T05:00:00Z';
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const content = '# Release\n\nToo short.\n';
    const client = {
      listProjects: vi
        .fn()
        .mockResolvedValue({ projects: [{ id: 'project-1', name: 'Sample Project' }] }),
      fetchProjectWorkspaceBlob: vi.fn().mockResolvedValue(new Blob([content])),
      listChatSessions: vi.fn().mockImplementation(() =>
        Promise.resolve({
          sessions: [
            {
              id: 'session-writer',
              gezelId: 'writer-1',
              projectId: 'project-1',
              lastActivityAt: sessionActivityAt,
            },
          ],
        }),
      ),
      listGezels: vi.fn().mockResolvedValue({ gezels: [{ id: 'writer-1', role: 'Writer' }] }),
      listInflightTurns: vi.fn().mockResolvedValue({
        inflight: [
          {
            sessionId: 'session-writer',
            gezelId: 'writer-1',
            projectId: 'project-1',
            elapsedMs: 75_000,
          },
        ],
      }),
      messageGezel: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const scenario = craftbookScenarioFromSpec({
      ...directWorkerSpec(),
      success: {
        summary: 'workspace/press-release.md is substantial.',
        deliverables: [{ path: 'press-release.md', kind: 'markdown-doc', minBytes: 800 }],
      },
    });
    const ctx = {
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
      recordSniff: vi.fn(),
    } as unknown as EvalContext;

    try {
      await expect(scenario.successCheck(ctx)).resolves.toEqual({ done: false });
      now = startedAt + 30_000;
      await expect(scenario.successCheck(ctx)).resolves.toEqual({ done: false });
      now = startedAt + 65_000;
      sessionActivityAt = '2026-06-28T05:01:05Z';
      await expect(scenario.successCheck(ctx)).resolves.toEqual({ done: false });
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe('prioritizeRepairFailures — structural totals outrank per-record treadmills', () => {
  it('leads with count/conservation floors, demotes per-record field misses', () => {
    const failures = [
      'albums/lake-weekend.json: record 4 is missing required field "caption"',
      'albums/lake-weekend.json: 8 record(s), need ≥ 10',
      'albums/lake-weekend.json: output carries 8 value(s) matching /(IMG_\\d{4}\\.jpg)/, need ≥ 10 — the transform must preserve the source values, not drop them.',
      'report.md is missing required content: the cull is explained',
    ];
    const ordered = prioritizeRepairFailures(failures);
    expect(ordered[0]).toContain('8 record(s), need ≥ 10');
    expect(ordered[1]).toContain('output carries 8 value(s)');
    expect(ordered[ordered.length - 1]).toContain('record 4 is missing');
  });

  it('keeps executable failures ahead of structural totals', () => {
    const failures = [
      'albums/x.json: record 2 is missing required field "caption"',
      'albums/x.json: 8 record(s), need ≥ 10',
      'checks/verify.mjs did not pass when run with node: exit=1',
    ];
    const ordered = prioritizeRepairFailures(failures);
    expect(ordered[0]).toContain('did not pass when run with node');
    expect(ordered[1]).toContain('8 record(s), need ≥ 10');
  });
});
