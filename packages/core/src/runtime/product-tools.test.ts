import { describe, expect, it, vi } from 'vitest';
import { portableToolResultText } from './portable-tool-results.js';
import {
  type PortableToolActions,
  executePortableTool,
  portableToolSurface,
} from './product-tools.js';
import { portableFixture } from './test-files.js';
import { runPortableToolLoop } from './tool-loop.js';

const actions: PortableToolActions = {
  recruit: async () => {
    throw new Error('unexpected recruitment');
  },
  templates: () => [],
  createTask: async () => {},
  completeTask: async () => {},
  assertHandoffAllowed: () => {},
  message: async () => {},
  startProject: async () => {},
};
async function fixture() {
  const { store } = portableFixture();
  await store.ensureLayout();
  const gezel = await store.createGezel({ name: 'Noor', role: 'Generalist' });
  const session = await store.createSession({ gezelId: gezel.id, providerName: 'llama-cpp' });
  return { store, gezel, session };
}

describe('portable tool authority and durable effects', () => {
  it('applies the same exact authored step ceiling before advertising and executing', async () => {
    const { store, gezel } = await fixture();
    const task = await store.createTask('default', {
      title: 'Read report',
      description: 'Read the project report and identify the decisions that need review.',
      steps: [
        { name: 'Review', prompt: 'Read the file', toolPolicy: { allowTools: ['read_file'] } },
      ],
    });
    const session = await store.createSession({
      gezelId: gezel.id,
      taskRef: task.ref,
      stepId: task.activeStepId,
      providerName: 'llama-cpp',
    });
    expect((await portableToolSurface(store, session)).map((tool) => tool.name)).toEqual([
      'read_file',
    ]);
    await expect(
      executePortableTool(
        store,
        session,
        'write_file',
        { path: 'report.md', content: 'bad' },
        actions,
      ),
    ).rejects.toThrow('unavailable');
    expect(await store.readFile('workspace', 'default', 'report.md')).toBeNull();
  });

  it('explains a rejected argument in words the model can retry from', async () => {
    const { store, session } = await fixture();
    await expect(
      executePortableTool(
        store,
        session,
        'write_artifact',
        { path: 'note.md', content: 'Hi', create: true },
        actions,
      ),
    ).rejects.toThrow(
      'write_artifact does not take `create`. It takes: path, content (? is optional). Call it again with corrected arguments.',
    );
    await expect(
      executePortableTool(store, session, 'write_artifact', { path: 'note.md' }, actions),
    ).rejects.toThrow('write_artifact needs `content`.');
    expect(await store.readFile('artifacts', 'default', 'note.md')).toBeNull();
  });

  // Told every key after a bad optional value, Gemini Nano sent them all back.
  it('answers a bad optional value with leaving it out, not the whole key list', async () => {
    const { store, session } = await fixture();
    const rejection = executePortableTool(
      store,
      session,
      'ask_user_question',
      { question: 'What is the project for?', taskRef: 'default' },
      { ...actions, askQuestion: async () => ({ questionId: 'q1' }) },
    );
    await expect(rejection).rejects.toThrow(
      'ask_user_question `taskRef`: task ref must use projectId/num form. Leave out `taskRef`: it is optional. Call it again with corrected arguments.',
    );
  });

  it('honors output-medium and group exclusions without elevating the role', async () => {
    const { store, gezel } = await fixture();
    const task = await store.createTask('default', {
      title: 'Review',
      description: 'Review the project and save the completed report in its artifacts.',
      steps: [
        {
          name: 'Review',
          prompt: 'Read source and produce the report.',
          toolPolicy: { outputMedium: 'artifact', disallowBuiltinToolsets: ['code-execution'] },
        },
      ],
    });
    const session = await store.createSession({
      gezelId: gezel.id,
      taskRef: task.ref,
      stepId: task.activeStepId,
      providerName: 'llama-cpp',
    });
    const tools = (await portableToolSurface(store, session, true)).map((tool) => tool.name);
    expect(tools).toContain('read_file');
    expect(tools).toContain('write_artifact');
    expect(tools).not.toContain('write_file');
    expect(tools).not.toContain('write_document');
    expect(tools).not.toContain('run_installed_script');
    expect(tools).not.toContain('start_project');
    expect(await portableToolSurface(store, { ...session, taskRef: 'default/999' })).toEqual([]);
  });

  it('checks the current project policy again at the effect boundary', async () => {
    const { store, session } = await fixture();
    expect(
      (await portableToolSurface(store, session)).some((tool) => tool.name === 'write_file'),
    ).toBe(true);
    await store.updateProject('default', { status: 'readonly' });
    await expect(
      executePortableTool(
        store,
        session,
        'write_file',
        { path: 'blocked.md', content: 'bad' },
        actions,
      ),
    ).rejects.toThrow('read-only');
    expect(await store.readFile('workspace', 'default', 'blocked.md')).toBeNull();
  });

  it('runs the only installed script of that name when the call names no scope', async () => {
    const { store, session } = await fixture();
    const installed = [{ name: 'storeRecords', scope: 'standard' }];
    const scripts = {
      list: vi.fn(async () => ({ items: installed, count: installed.length })),
      run: vi.fn(async () => ({ status: 'ok' })),
    };
    const enabled = { ...actions, scripts };
    await executePortableTool(
      store,
      session,
      'run_installed_script',
      { name: 'storeRecords' },
      enabled,
    );
    expect(scripts.run).toHaveBeenLastCalledWith('storeRecords', {}, session, 'standard');
    installed.push({ name: 'storeRecords', scope: 'project' });
    await executePortableTool(
      store,
      session,
      'run_installed_script',
      { name: 'storeRecords' },
      enabled,
    );
    expect(scripts.run).toHaveBeenLastCalledWith('storeRecords', {}, session, 'project');
  });

  it('uses installed-script desktop inputs and default scope without crossing project authority', async () => {
    const { store, session } = await fixture();
    const other = await store.createProject({ name: 'Private project' });
    const scripts = { list: vi.fn(() => []), run: vi.fn(async () => ({ status: 'ok' })) };
    const enabled = { ...actions, scripts };
    await executePortableTool(
      store,
      session,
      'run_installed_script',
      { name: 'report', input: { title: 'Brief' } },
      enabled,
    );
    expect(scripts.run).toHaveBeenLastCalledWith('report', { title: 'Brief' }, session, 'project');
    await executePortableTool(
      store,
      session,
      'run_installed_script',
      { name: 'checkContains', scope: 'standard' },
      enabled,
    );
    expect(scripts.run).toHaveBeenLastCalledWith('checkContains', {}, session, 'standard');
    // As on the desktop, a project-confined gezel's project argument means its
    // own project: another project's id never reaches that project.
    await executePortableTool(store, session, 'list_scripts', { project: other.id }, enabled);
    expect(scripts.list).toHaveBeenLastCalledWith(session.projectId);
    await executePortableTool(
      store,
      session,
      'run_installed_script',
      { project: other.id, name: 'report' },
      enabled,
    );
    expect(scripts.run).toHaveBeenLastCalledWith('report', {}, session, 'project');
    await expect(
      executePortableTool(
        store,
        session,
        'get_script_run',
        { project: other.id, runId: 'private' },
        enabled,
      ),
    ).rejects.toThrow();
    expect(scripts.run).toHaveBeenCalledTimes(3);
  });

  it('keeps the Meester coordinator role from acquiring script execution', async () => {
    const { store } = await fixture();
    const session = await store.createSession({
      gezelId: (await store.readConfig()).meesterGezelId!,
      providerName: 'llama-cpp',
    });
    const target = await store.createProject({ name: 'Protected' });
    await store.updateProject(target.id, { status: 'readonly' });
    const run = vi.fn(async () => ({}));
    await expect(
      executePortableTool(
        store,
        session,
        'run_installed_script',
        { project: target.id, name: 'report' },
        { ...actions, scripts: { list: () => [], run } },
      ),
    ).rejects.toThrow('unavailable');
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps team authority scoped by role, solo mode, and destination project status', async () => {
    const { store, session, gezel } = await fixture();
    const target = await store.createProject({ name: 'Other project' });
    await expect(
      executePortableTool(
        store,
        session,
        'add_gezel_to_project',
        { project: target.id, gezel: gezel.id },
        actions,
      ),
    ).rejects.toThrow('unavailable');
    const meester = (await store.readConfig()).meesterGezelId!;
    const teamSession = await store.createSession({ gezelId: meester, providerName: 'llama-cpp' });
    await store.updateProject(target.id, { status: 'readonly' });
    await expect(
      executePortableTool(
        store,
        teamSession,
        'add_gezel_to_project',
        { project: target.id, gezel: gezel.id },
        actions,
      ),
    ).rejects.toThrow('destination');
    await expect(
      executePortableTool(
        store,
        teamSession,
        'update_project',
        { id: target.id, about: 'Changed' },
        actions,
      ),
    ).rejects.toThrow('destination');
    await store.updateProject('default', { mode: 'solo' });
    expect((await portableToolSurface(store, teamSession)).map((tool) => tool.name)).not.toContain(
      'message_gezel',
    );
    expect((await store.getProjectGezels(target.id)).map((member) => member.id)).not.toContain(
      gezel.id,
    );
  });

  it('names a task owner the way the desktop does: id, name, role, or "user"', async () => {
    const { store, gezel, session } = await fixture();
    const created: unknown[] = [];
    const recording = {
      ...actions,
      createTask: async (input: unknown) => void created.push(input),
    };
    const task = (assignee?: unknown) => ({
      project: 'default',
      title: 'Repair day',
      description:
        'Plan the repair day so every neighbour knows the date, venue and what to bring.',
      steps: [{ id: 'plan', name: 'Plan', suggestedRole: 'Generalist' }],
      ...(assignee === undefined ? {} : { assignee }),
    });
    const humanHandoff = { kind: 'user', instructions: 'Choose the repair date and reply here.' };
    for (const assignee of ['Noor', 'noor', gezel.id, 'user', 'gezel', humanHandoff])
      await executePortableTool(store, session, 'create_task', task(assignee), recording);
    expect(created.map((input) => (input as { assignee?: unknown }).assignee)).toEqual([
      { kind: 'gezel', gezelId: gezel.id },
      { kind: 'gezel', gezelId: gezel.id },
      { kind: 'gezel', gezelId: gezel.id },
      { kind: 'user' },
      undefined,
      humanHandoff,
    ]);
    await expect(
      executePortableTool(store, session, 'create_task', task('Zed'), recording),
    ).rejects.toThrow(/gezel "Zed" not found\. Available: .*"Noor"|Noor/);
  });

  it('reads a model path the way the desktop tools do', async () => {
    const { store, session } = await fixture();
    await executePortableTool(
      store,
      session,
      'write_artifact',
      { path: 'artifacts/cabinet-note.md', content: 'ORCHARD-7284' },
      actions,
    );
    expect(await store.readFile('artifacts', session.projectId, 'cabinet-note.md')).toBe(
      'ORCHARD-7284',
    );
    await executePortableTool(
      store,
      session,
      'write_file',
      { path: './notes//a.md', content: 'a' },
      actions,
    );
    expect(await store.readFile('workspace', session.projectId, 'notes/a.md')).toBe('a');
    // A bare `artifacts` is the drawer, not a folder inside it.
    const listed = (await executePortableTool(
      store,
      session,
      'list_artifacts',
      { path: 'artifacts', recursive: true },
      actions,
    )) as { entries: { path: string }[] };
    expect(listed.entries.map((entry) => entry.path)).toContain('cabinet-note.md');
  });

  it('says a listed folder does not exist, and names the file the model probably meant', async () => {
    const { store, session } = await fixture();
    await executePortableTool(
      store,
      session,
      'write_file',
      { path: 'repairs.json', content: '{}' },
      actions,
    );
    const list = async (path: string) => {
      const raw = await executePortableTool(store, session, 'list_dir', { path }, actions);
      return (await portableToolResultText(store, session, 'list_dir', { path }, raw))?.text;
    };
    expect(await list('repairs')).toBe(
      'No folder or file exists at `repairs`. Did you mean `repairs.json`?',
    );
    expect(await list('repairs.json')).toBe(
      '`repairs.json` is a file, not a folder. Read the file instead.',
    );
    await executePortableTool(
      store,
      session,
      'write_file',
      { path: 'empty/.keep', content: '' },
      actions,
    );
    expect(await list('empty')).toBe('Empty directory.');
  });

  it('reads a path that starts with the drawer name as a workspace path', async () => {
    const { store, session } = await fixture();
    const write = (path: string, content: string) =>
      executePortableTool(store, session, 'write_file', { path, content }, actions);
    await write('project/workspace/result.json', '{"total":28}');
    expect(await store.readFile('workspace', session.projectId, 'result.json')).toBe(
      '{"total":28}',
    );
    // A project with a real `workspace/` folder keeps it.
    await write('workspace/keep.md', 'mine');
    expect(await store.readFile('workspace', session.projectId, 'keep.md')).toBe('mine');
    await store.writeFile('workspace', session.projectId, 'workspace/.keep', '');
    await write('workspace/nested.md', 'nested');
    expect(await store.readFile('workspace', session.projectId, 'workspace/nested.md')).toBe(
      'nested',
    );
  });

  it('reads a task ref that names the project by its display name, as on the desktop', async () => {
    const { store, gezel } = await fixture();
    const task = await store.createTask('default', {
      title: 'Write a note',
      description: 'Write the handover note for the next volunteer on the cabinet.',
      assignee: { kind: 'gezel', gezelId: gezel.id },
      steps: [{ id: 'write', name: 'Write', prompt: 'Write it.' }],
    });
    const session = await store.createSession({
      gezelId: gezel.id,
      providerName: 'llama-cpp',
      taskRef: task.ref,
      stepId: 'write',
    });
    await store.updateProject('default', { name: 'Repair Crew' });
    const notes = await executePortableTool(
      store,
      session,
      'read_task_notes',
      { ref: `Repair Crew/${task.num}` },
      actions,
    );
    expect(notes).toBeDefined();
  });

  it('lets a team gezel name a project by id or display name, as on the desktop', async () => {
    const { store, gezel } = await fixture();
    const target = await store.createProject({ name: 'Repair Cafe' });
    const meester = (await store.readConfig()).meesterGezelId!;
    const teamSession = await store.createSession({ gezelId: meester, providerName: 'llama-cpp' });
    await executePortableTool(
      store,
      teamSession,
      'add_gezel_to_project',
      { project: 'repair cafe', gezel: gezel.id },
      actions,
    );
    expect((await store.getProjectGezels(target.id)).map((member) => member.id)).toContain(
      gezel.id,
    );
    await expect(
      executePortableTool(
        store,
        teamSession,
        'add_gezel_to_project',
        { project: 'Nowhere', gezel: gezel.id },
        actions,
      ),
    ).rejects.toThrow(
      /project "Nowhere" does not exist\. Available projects: .*"Repair Cafe"|Repair Cafe/,
    );
  });

  it('writes attributed task notes using desktop argument aliases and enforces task/step scope', async () => {
    const { store, gezel } = await fixture();
    const input = {
      title: 'Review',
      description: 'Read the project report and record a concise evidence-based conclusion.',
      steps: [
        { name: 'Read' },
        { name: 'Review', toolPolicy: { outputMedium: 'task-note' as const } },
      ],
    };
    const task = await store.createTask('default', input);
    const other = await store.createTask('default', input);
    const session = await store.createSession({
      gezelId: gezel.id,
      taskRef: task.ref,
      stepId: task.activeStepId,
      providerName: 'llama-cpp',
    });
    for (const alias of ['text', 'note', 'content'])
      await executePortableTool(
        store,
        session,
        'write_task_note',
        { ref: task.ref, [alias]: `${alias} note` },
        actions,
      );
    const notes = await store.listTaskNotes(task.ref);
    expect(notes).toHaveLength(3);
    expect(notes[0]?.author).toEqual({ kind: 'gezel', gezelId: gezel.id, name: gezel.name });
    expect(notes.every((note) => note.stepId === task.activeStepId)).toBe(true);
    const response = (await executePortableTool(
      store,
      session,
      'read_task_notes',
      { ref: task.ref },
      actions,
    )) as { details: { notes: typeof notes } };
    expect(response.details.notes.map((note) => note.text)).toEqual([
      'content note',
      'note note',
      'text note',
    ]);
    await expect(
      executePortableTool(
        store,
        session,
        'write_task_note',
        { ref: other.ref, text: 'wrong task' },
        actions,
      ),
    ).rejects.toThrow('current task');
    await expect(
      executePortableTool(
        store,
        session,
        'write_task_note',
        { ref: task.ref, stepId: task.craftbook.steps[1]!.id, text: 'wrong step' },
        actions,
      ),
    ).rejects.toThrow('current step');
    await expect(
      executePortableTool(store, session, 'write_task_note', { ref: task.ref }, actions),
    ).rejects.toThrow('note body');
    const noteSession = { ...session, stepId: task.craftbook.steps[1]!.id };
    const names = (await portableToolSurface(store, noteSession)).map((tool) => tool.name);
    expect(names).toContain('write_task_note');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('write_artifact');
  });

  it('allows the active step worker to advance while retaining the task owner and denying stale sessions', async () => {
    const { store, gezel } = await fixture();
    const owner = (await store.readConfig()).meesterGezelId!;
    const task = await store.createTask('default', {
      title: 'Review',
      description: 'Read the supplied project and produce a report for its owner.',
      assignee: { kind: 'gezel', gezelId: owner },
      steps: [
        { name: 'Write report', assignee: { kind: 'gezel', gezelId: gezel.id } },
        { name: 'Review report', assignee: { kind: 'user' } },
      ],
    });
    const session = await store.createSession({
      gezelId: gezel.id,
      taskRef: task.ref,
      stepId: task.activeStepId,
      providerName: 'llama-cpp',
    });
    const completeTask = vi.fn(async (ref: string) => {
      const current = await store.getTask(ref);
      return store.completeTaskStep(ref, current!.activeStepId!);
    });
    await executePortableTool(
      store,
      session,
      'advance_task_step',
      { ref: task.ref, stepId: task.activeStepId },
      { ...actions, completeTask },
    );
    expect(completeTask).toHaveBeenCalledTimes(1);
    expect((await store.getTask(task.ref))?.assignee).toEqual({ kind: 'gezel', gezelId: owner });
    await expect(
      executePortableTool(
        store,
        session,
        'advance_task_step',
        { ref: task.ref, stepId: (await store.getTask(task.ref))!.activeStepId },
        { ...actions, completeTask },
      ),
    ).rejects.toThrow('current task step');
    const userStepSession = await store.createSession({
      gezelId: session.gezelId,
      projectId: session.projectId,
      taskRef: task.ref,
      stepId: (await store.getTask(task.ref))!.activeStepId,
    });
    await expect(
      executePortableTool(
        store,
        userStepSession,
        'advance_task_step',
        { ref: task.ref, stepId: userStepSession.stepId },
        { ...actions, completeTask },
      ),
    ).rejects.toThrow('awaits the user');
    expect(completeTask).toHaveBeenCalledTimes(1);
  });

  for (const failedCheckpoint of [1, 2])
    it(`does not admit more effects after audit checkpoint ${failedCheckpoint} fails`, async () => {
      const { store, session } = await fixture();
      const generate = vi.fn(async () => ({
        text: JSON.stringify({
          name: 'write_artifact',
          arguments: { path: 'proof.md', content: 'saved' },
        }),
        stopReason: 'stop' as const,
      }));
      let calls = 0;
      const checkpoint = vi.fn(async () => {
        if (++calls === failedCheckpoint) throw new Error('Disk unavailable');
      });
      await expect(
        runPortableToolLoop({
          store,
          session,
          inference: { providers: async () => [], generate, cancel: async () => {} },
          requestId: 'req',
          providerId: 'llama-cpp',
          modelId: 'test',
          contextSize: 8000,
          maxTokens: 500,
          messages: [],
          actions,
          cancelled: () => false,
          checkpoint,
          tool: () => {},
          delta: () => {},
        }),
      ).rejects.toThrow('Disk unavailable');
      expect(generate).toHaveBeenCalledTimes(1);
      expect(await store.readFile('artifacts', 'default', 'proof.md')).toBe(
        failedCheckpoint === 1 ? null : 'saved',
      );
      expect(checkpoint).toHaveBeenCalledTimes(failedCheckpoint);
    });

  it('keeps completed action audit but suppresses completion receipts after cancellation during save', async () => {
    const { store, session, gezel } = await fixture();
    const task = await store.createTask('default', {
      title: 'Finish task',
      description: 'Review the completed local work and finish this single-step task.',
      assignee: { kind: 'gezel', gezelId: gezel.id },
      steps: [{ name: 'Finish', terminal: true }],
    });
    const generate = vi.fn(async () => ({
      text: JSON.stringify({
        name: 'advance_task_step',
        arguments: { ref: task.ref, stepId: task.activeStepId },
      }),
      stopReason: 'stop' as const,
    }));
    let cancelled = false;
    let saves = 0;
    const result = await runPortableToolLoop({
      store,
      session,
      inference: { providers: async () => [], generate, cancel: async () => {} },
      requestId: 'req',
      providerId: 'llama-cpp',
      modelId: 'test',
      contextSize: 8000,
      maxTokens: 500,
      messages: [],
      actions: {
        ...actions,
        completeTask: (ref) => store.completeTaskStep(ref, task.activeStepId!),
      },
      cancelled: () => cancelled,
      checkpoint: async () => {
        if (++saves === 2) cancelled = true;
      },
      tool: () => {},
      delta: () => {},
    });
    expect(result).toMatchObject({ text: '', stopReason: 'cancelled' });
    expect(result.message?.toolCalls?.[0]).toMatchObject({
      name: 'advance_task_step',
      success: true,
    });
    expect((await store.getTask(task.ref))?.status).toBe('complete');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('never executes an envelope embedded in prose or truncated by the provider', async () => {
    const { store, session } = await fixture();
    const envelope = JSON.stringify({
      name: 'write_artifact',
      arguments: { path: 'bad.md', content: 'bad' },
    });
    for (const result of [
      { text: `Example: ${envelope}`, stopReason: 'stop' as const },
      { text: envelope, stopReason: 'length' as const },
      { text: `Here is the call:\n\`\`\`json\n${envelope}\n\`\`\``, stopReason: 'stop' as const },
      { text: `\`\`\`json\n${envelope}\n\`\`\`\nThat writes it.`, stopReason: 'stop' as const },
      { text: `\`\`\`json\n${envelope}\n\`\`\``, stopReason: 'length' as const },
      // A cut-off call looks exactly like one a model forgot to close.
      { text: envelope.slice(0, -1), stopReason: 'length' as const },
    ]) {
      const checkpoint = vi.fn();
      await runPortableToolLoop({
        store,
        session,
        inference: {
          providers: async () => [],
          generate: async () => result,
          cancel: async () => {},
        },
        requestId: 'req',
        providerId: 'llama-cpp',
        modelId: 'test',
        contextSize: 8000,
        maxTokens: 500,
        messages: [],
        actions,
        cancelled: () => false,
        checkpoint,
        tool: () => {},
        delta: () => {},
      });
      expect(checkpoint).not.toHaveBeenCalled();
    }
    expect(await store.readFile('artifacts', 'default', 'bad.md')).toBeNull();
  });

  for (const outcome of [
    'advance',
    'complete',
    'paused',
    'canceled',
    'failed-after-advance',
    'held',
  ] as const)
    it(`checks the durable task after a script returns ${outcome}`, async () => {
      const { store, gezel } = await fixture();
      const task = await store.createTask('default', {
        title: 'Scripted review',
        description: 'Write the review and advance only when the script gate accepts it.',
        assignee: { kind: 'gezel', gezelId: gezel.id },
        steps:
          outcome === 'complete'
            ? [{ name: 'Review', terminal: true }]
            : [{ name: 'Review' }, { name: 'Approval', assignee: { kind: 'user' } }],
      });
      const session = await store.createSession({
        gezelId: gezel.id,
        taskRef: task.ref,
        stepId: task.activeStepId,
        providerName: 'llama-cpp',
      });
      const generate = vi
        .fn()
        .mockResolvedValueOnce({
          text: JSON.stringify({ name: 'run_installed_script', arguments: { name: 'review' } }),
          stopReason: 'stop',
        })
        .mockResolvedValue({ text: 'The gate needs another review.', stopReason: 'stop' });
      const result = await runPortableToolLoop({
        store,
        session,
        inference: { providers: async () => [], generate, cancel: async () => {} },
        requestId: 'req',
        providerId: 'llama-cpp',
        modelId: 'test',
        contextSize: 8000,
        maxTokens: 500,
        messages: [],
        actions: {
          ...actions,
          scripts: {
            list: () => [],
            run: async () => {
              if (outcome === 'paused' || outcome === 'canceled')
                await store.setTaskStatus(task.ref, outcome);
              else if (outcome !== 'held')
                await store.completeTaskStep(task.ref, task.activeStepId!);
              if (outcome === 'failed-after-advance') throw new Error('Script failed after commit');
              return { status: 'ok' };
            },
          },
        },
        cancelled: () => false,
        checkpoint: async () => {},
        tool: () => {},
        delta: () => {},
      });
      expect(generate).toHaveBeenCalledTimes(outcome === 'held' ? 2 : 1);
      expect(result.stopReason).toBe('stop');
      expect(result.message?.toolCalls?.[0]?.success).toBe(outcome !== 'failed-after-advance');
      if (outcome === 'complete') expect(result.text).toBe('The task is complete.');
      else if (outcome === 'held') expect(result.text).toBe('The gate needs another review.');
      else if (outcome === 'paused' || outcome === 'canceled')
        expect(result.text).toContain(outcome);
      else expect(result.text).toContain('another step');
    });
});
