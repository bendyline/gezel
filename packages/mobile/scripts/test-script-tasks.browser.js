/** Runs in the local browser contract harness with real compiler and QuickJS workers. */
export async function testScriptTasks({ client, store, scripts, service, files, check, leadId }) {
  const taskInput = {
    title: 'SDK lifecycle task',
    description: 'Prepare a local task, preserve its gate, and write its finished artifact.',
    assignee: { kind: 'user' },
    steps: [
      {
        name: 'Prepare',
        terminal: true,
        gate: {
          at: 'completion',
          checks: [{ kind: 'minBytes', file: 'task-sdk-required.md', artifact: true, bytes: 5 }],
          scripts: [{ name: 'sdkReview', scope: 'project' }],
        },
        onExit: { name: 'sdkFinish', scope: 'project' },
      },
    ],
  };
  const source = (name, requires, body, inputs = {}) =>
    `import {defineScript,gezel} from '@bendyline/gezel-sdk'; export const meta=defineScript({name:${JSON.stringify(name)},description:'Offline task SDK browser contract',requires:${JSON.stringify(requires)},inputs:${JSON.stringify(inputs)}} as const); ${body}`;
  await client.createProjectScript('default', {
    name: 'sdkReview',
    source: source(
      'sdkReview',
      ['artifacts.read'],
      "await gezel.artifacts.read('task-sdk-required.md'); gezel.output({decision:'approve'});",
    ),
  });
  await client.createProjectScript('default', {
    name: 'sdkFinish',
    source: source(
      'sdkFinish',
      ['artifacts.write'],
      "await gezel.artifacts.write('task-sdk-finished.md','Finished through the checked transition');",
    ),
  });
  await client.createProjectScript('default', {
    name: 'sdkTaskFlow',
    source: source(
      'sdkTaskFlow',
      ['tasks.read', 'tasks.write', 'artifacts.write'],
      `
const task=await gezel.task.create(${JSON.stringify(taskInput)}) as {ref:string};
await gezel.task.update(task.ref,{title:'Updated through QuickJS'});
const held=await gezel.task.advance(task.ref) as {status:string};
if(held.status!=='held')throw new Error('Gate was bypassed');
await gezel.artifacts.write('task-sdk-required.md','Ready for review');
const advanced=await gezel.task.advance(task.ref) as {status:string};
const saved=await gezel.task.get(task.ref) as {title:string,status:string};
gezel.output({ref:task.ref,held:held.status,advanced:advanced.status,title:saved.title,status:saved.status});`,
    ),
  });
  const audits = new Map();
  const persist = store.writeScriptRun.bind(store);
  let afterAudit = async (_run) => {};
  store.writeScriptRun = async (run) => {
    await persist(run);
    audits.set(run.id, structuredClone(run));
    await afterAudit(run);
  };
  try {
    const flow = await client.runProjectScript('default', { name: 'sdkTaskFlow' });
    check(flow.status === 'ok', `Task SDK workflow failed: ${flow.error}`);
    check(
      flow.output.held === 'held' &&
        flow.output.advanced === 'advanced' &&
        flow.output.status === 'complete' &&
        flow.output.title === 'Updated through QuickJS',
      'Task SDK did not preserve task or gate semantics',
    );
    check(
      (await store.readFile('artifacts', 'default', 'task-sdk-finished.md'))?.includes(
        'checked transition',
      ),
      'Task SDK exit hook did not run',
    );
    const children = [...audits.values()].filter((run) => run.parentRunId === flow.runId);
    check(
      children.length === 2 &&
        children.every(
          (run) =>
            run.status === 'ok' &&
            run.trigger.kind === 'step' &&
            run.trigger.taskRef === flow.output.ref,
        ),
      'Task gate/exit child audits lost their parent or step identity',
    );
    for (const child of children)
      check(
        (await client.getProjectScriptRun('default', child.id)).parentRunId === flow.runId,
        'Child audit was not persisted',
      );

    await testActivationLoop({
      client,
      store,
      scripts,
      service,
      files,
      check,
      leadId,
      source,
      audits,
      observe: (callback) => {
        afterAudit = callback;
      },
    });

    const bareTask = {
      ...taskInput,
      title: 'SDK current task',
      assignee: { kind: 'gezel', gezelId: leadId },
      steps: [{ name: 'Prepare', terminal: true }],
    };
    const revokedTask = await client.createTask('default', {
      ...bareTask,
      title: 'SDK revoked completion',
      steps: [
        {
          name: 'Review',
          terminal: true,
          gate: { at: 'completion', scripts: [{ name: 'sdkReview', scope: 'project' }] },
        },
      ],
    });
    await client.createProjectScript('default', {
      name: 'sdkAdvanceTarget',
      source: source(
        'sdkAdvanceTarget',
        ['tasks.write'],
        'await gezel.task.advance(String(gezel.input.target));',
        {
          target: { type: 'string', description: 'Task reference', required: true },
        },
      ),
    });
    const chat = await store.createSession({
      gezelId: leadId,
      projectId: 'default',
      providerName: 'llama-cpp',
    });
    const priorConfig = await store.readConfig();
    try {
      afterAudit = async (audit) => {
        if (
          audit.scriptName === 'sdkReview' &&
          audit.status === 'ok' &&
          audit.trigger.kind === 'step' &&
          audit.trigger.taskRef === revokedTask.ref
        ) {
          await store.writeConfig({
            securityPolicy: { ...priorConfig.securityPolicy, allowScriptExecution: false },
          });
        }
      };
      const revoked = await scripts.run({
        projectId: 'default',
        scriptName: 'sdkAdvanceTarget',
        inputs: { target: revokedTask.ref },
        trigger: { kind: 'chat', gezelId: leadId, sessionId: chat.id },
      });
      check(
        revoked.status === 'error' && revoked.error.includes('script execution is disabled'),
        'Task completion ignored parent script policy revocation after its gate',
      );
      check(
        (await store.getTask(revokedTask.ref))?.activeStepId === revokedTask.activeStepId,
        'Revoked script committed a transition',
      );
    } finally {
      afterAudit = async (_run) => {};
      await store.writeConfig({ securityPolicy: priorConfig.securityPolicy });
    }
    const current = await client.createTask('default', bareTask);
    const other = await client.createTask('default', { ...bareTask, title: 'SDK other task' });
    const session = await store.createSession({
      gezelId: leadId,
      projectId: 'default',
      providerName: 'llama-cpp',
      taskRef: current.ref,
      stepId: current.activeStepId,
    });
    const input = { target: { type: 'string', description: 'Task reference', required: true } };
    await client.createProjectScript('default', {
      name: 'sdkTaskBounds',
      source: source(
        'sdkTaskBounds',
        ['tasks.write'],
        "await gezel.task.update(String(gezel.input.target),{title:'Unauthorized'});",
        input,
      ),
    });
    const bounds = await scripts.run({
      projectId: 'default',
      scriptName: 'sdkTaskBounds',
      inputs: { target: other.ref },
      trigger: { kind: 'chat', gezelId: leadId, sessionId: session.id },
    });
    check(
      bounds.status === 'error' && bounds.error.includes('current task'),
      'Task-bound script changed another task',
    );
    check(
      (await client.getTask('default', other.num)).title === 'SDK other task',
      'Cross-task mutation reached storage',
    );
    const outside = await store.createProject({ name: 'SDK outside project' });
    const outsideTask = await store.createTask(outside.id, bareTask);
    await client.createProjectScript('default', {
      name: 'sdkTaskReadBounds',
      source: source(
        'sdkTaskReadBounds',
        ['tasks.read'],
        'await gezel.task.get(String(gezel.input.target));',
        input,
      ),
    });
    const outsideRun = await client.runProjectScript('default', {
      name: 'sdkTaskReadBounds',
      input: { target: outsideTask.ref },
    });
    check(
      outsideRun.status === 'error' && outsideRun.error.includes('outside this project'),
      'Task script escaped its project',
    );

    await client.createProjectScript('default', {
      name: 'sdkReentry',
      source: source(
        'sdkReentry',
        ['tasks.write'],
        'await gezel.task.advance(String(gezel.input.taskRef));',
        { taskRef: { type: 'string', description: 'Current task', required: true } },
      ),
    });
    const reentry = await client.createTask('default', {
      ...bareTask,
      title: 'SDK lifecycle reentry',
      steps: [
        { name: 'Prepare', terminal: true, onEnter: { name: 'sdkReentry', scope: 'project' } },
      ],
    });
    await client.retryTask('default', reentry.num);
    for (let i = 0; i < 1000 && service.busy; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const stopped = await client.getTask('default', reentry.num);
    check(
      stopped.status === 'paused' && stopped.activeStepId === reentry.activeStepId,
      'Lifecycle script advanced past its own checkpoint',
    );
    const reentryAudit = [...audits.values()].find((run) => run.scriptName === 'sdkReentry');
    check(
      reentryAudit?.status === 'error' && reentryAudit.error.includes('lifecycle or gate script'),
      'Lifecycle reentry was not audited as denied',
    );

    await client.createProjectScript('default', {
      name: 'sdkSlowGate',
      source: source(
        'sdkSlowGate',
        ['artifacts.write'],
        "await gezel.artifacts.write('task-sdk-cancel-start.md','Started'); while(true){}",
      ),
    });
    const cancelTask = {
      ...taskInput,
      title: 'SDK canceled completion',
      steps: [
        {
          name: 'Review',
          terminal: true,
          gate: { at: 'completion', scripts: [{ name: 'sdkSlowGate', scope: 'project' }] },
        },
      ],
    };
    await client.createProjectScript('default', {
      name: 'sdkCancelAdvance',
      source: source(
        'sdkCancelAdvance',
        ['tasks.write', 'artifacts.write'],
        `const task=await gezel.task.create(${JSON.stringify(cancelTask)}) as {ref:string}; await gezel.task.advance(task.ref); await gezel.artifacts.write('task-sdk-late.md','Must not run');`,
      ),
    });
    const running = client.runProjectScript('default', { name: 'sdkCancelAdvance' });
    for (
      let i = 0;
      i < 500 &&
      (await store.readFile('artifacts', 'default', 'task-sdk-cancel-start.md')) === null;
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    check(
      (await store.readFile('artifacts', 'default', 'task-sdk-cancel-start.md')) !== null,
      'Completion gate worker did not start',
    );
    await scripts.cancel();
    const canceled = await running;
    check(
      canceled.status === 'error' && !scripts.isBusy(),
      'Task gate cancellation left the parent running',
    );
    check(
      (await store.readFile('artifacts', 'default', 'task-sdk-late.md')) === null,
      'Canceled parent performed a later effect',
    );
    const child = [...audits.values()].find(
      (run) => run.parentRunId === canceled.runId && run.scriptName === 'sdkSlowGate',
    );
    check(
      child?.status === 'error' && child.trigger.kind === 'step' && child.trigger.moment === 'gate',
      'Canceled gate child audit was lost',
    );
    check(
      (await store.getTask(child.trigger.taskRef))?.activeStepId === child.trigger.stepId,
      'Canceled gate committed a task transition',
    );
    check(
      (await client.getProjectScriptRun('default', child.id)).status === 'error',
      'Canceled gate audit was not durable',
    );
    return 7;
  } finally {
    store.writeScriptRun = persist;
  }
}

/** Contract only: all hooks/gates use the real compiler/QuickJS; no model result is supplied. */
async function testActivationLoop({
  client,
  store,
  scripts,
  service,
  files,
  check,
  leadId,
  source,
  audits,
  observe,
}) {
  const inputs = {
    taskRef: { type: 'string', description: 'Current task', required: true },
    stepId: { type: 'string', description: 'Current step', required: true },
  };
  await client.createProjectScript('default', {
    name: 'sdkActivationSetup',
    source: source(
      'sdkActivationSetup',
      ['artifacts.read', 'artifacts.write', 'tasks.write'],
      `
const count=Number(await gezel.artifacts.read('activation-count.txt'))+1;
if(count>2)throw new Error('Setup ran more than once per activation');
await gezel.artifacts.write('activation-count.txt',String(count));
await gezel.task.appendNote(String(gezel.input.taskRef),'Setup pass '+count);
gezel.output({ok:true,count});`,
      inputs,
    ),
  });
  await client.createProjectScript('default', {
    name: 'sdkActivationGate',
    source: source(
      'sdkActivationGate',
      ['artifacts.read'],
      `
const count=Number(await gezel.artifacts.read('activation-count.txt'));
if(count===1)gezel.output({decision:'reject',message:'Repeat setup for a second review pass',goto:String(gezel.input.stepId)});
else if(count===2)gezel.output({decision:'approve'});
else throw new Error('Gate ran before its setup');`,
      inputs,
    ),
  });
  await client.createProjectScript('default', {
    name: 'sdkActivationWrite',
    source: source(
      'sdkActivationWrite',
      ['artifacts.write'],
      "await gezel.artifacts.write('activation-forbidden.txt','This conversation bypassed setup');",
    ),
  });
  await store.writeFile('artifacts', 'default', 'activation-count.txt', '0');
  const task = await client.createTask('default', {
    title: 'QuickJS repeated activation',
    description:
      'Run authored preparation exactly once per activation and repeat it when the authored gate requests another pass.',
    assignee: { kind: 'gezel', gezelId: leadId },
    steps: [
      {
        name: 'Review',
        terminal: true,
        onEnter: { name: 'sdkActivationSetup', scope: 'project', autoAdvanceOnSuccess: true },
        gate: { at: 'completion', scripts: [{ name: 'sdkActivationGate', scope: 'project' }] },
      },
    ],
  });
  let oldSession;
  const activations = [];
  const denied = [];
  const complete = store.completeTaskStep.bind(store);
  observe(async (run) => {
    if (
      run.scriptName !== 'sdkActivationSetup' ||
      run.status !== 'ok' ||
      run.trigger.taskRef !== task.ref
    )
      return;
    const lifecycle = await store.getTaskLifecycle(task.ref);
    activations.push({ id: lifecycle.activationId, runId: run.id });
    oldSession ??= await store.createSession({
      gezelId: leadId,
      projectId: 'default',
      providerName: 'llama-cpp',
      taskRef: task.ref,
      stepId: task.activeStepId,
    });
  });
  store.completeTaskStep = async (...args) => {
    const result = await complete(...args);
    if (args[0] === task.ref && result.task.status === 'active') {
      check(result.task.activeStepId === task.activeStepId, 'Gate did not route to the same step');
      const lifecycle = await store.getTaskLifecycle(task.ref);
      check(lifecycle.entries.length === 0, 'New activation reused the old setup checkpoint');
      const freshSession = await store.createSession({
        gezelId: leadId,
        projectId: 'default',
        providerName: 'llama-cpp',
        taskRef: task.ref,
        stepId: task.activeStepId,
      });
      // The real transition is held after commit solely to observe the boundary
      // before the foreground runner starts the next onEnter hook.
      for (const [session, reason] of [
        [oldSession, 'changed activation'],
        [freshSession, 'setup'],
      ]) {
        const run = await scripts.run({
          projectId: 'default',
          scriptName: 'sdkActivationWrite',
          scope: 'project',
          trigger: { kind: 'chat', gezelId: leadId, sessionId: session.id },
        });
        denied.push(run.id);
        check(
          run.status === 'error' && run.error.includes(reason),
          `${reason} did not block the real QuickJS conversation effect`,
        );
        check(
          run.calls.length === 1 && run.calls[0].error.includes(reason),
          'Denied conversation effect lost its call audit',
        );
      }
      check(
        (await store.readFile('artifacts', 'default', 'activation-forbidden.txt')) === null,
        'Conversation acted before setup',
      );
    }
    return result;
  };
  try {
    await client.retryTask('default', task.num);
    for (let i = 0; service.busy && i < 1000; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const current = await client.getTask('default', task.num);
    if (service.busy || current.status !== 'complete')
      globalThis.__scriptFailure = {
        reason: 'authored same-step activation loop did not finish',
        busy: service.busy,
        task: current,
        lifecycle: await store.getTaskLifecycle(task.ref),
        activations,
        audits: [...audits.values()].filter(
          (run) => run.trigger.taskRef === task.ref || denied.includes(run.id),
        ),
      };
    check(
      !service.busy && current.status === 'complete',
      'Authored same-step activation loop did not finish',
    );
    check(
      (await store.readFile('artifacts', 'default', 'activation-count.txt')) === '2',
      'Setup did not rerun exactly once for each activation',
    );
    check(
      activations.length === 2 && activations[0].id !== activations[1].id,
      'Same-step gate did not create distinct durable activations',
    );
    check(
      denied.length === 2,
      'Old and fresh conversations were not checked before the repeated setup',
    );
    const notes = (await client.listTaskNotes('default', task.num)).notes;
    check(
      JSON.stringify(notes.map((note) => note.text)) ===
        JSON.stringify(['Setup pass 1', 'Setup pass 2']),
      'Setup notes were duplicated or lost',
    );
    const gateRuns = [...audits.values()].filter(
      (run) => run.scriptName === 'sdkActivationGate' && run.trigger.taskRef === task.ref,
    );
    check(
      gateRuns.length === 2 &&
        gateRuns[0].output.decision === 'reject' &&
        gateRuns[1].output.decision === 'approve',
      'Authored gate did not reject then approve',
    );
    for (const activation of activations) {
      const bytes = await files.read(
        `projects/default/tasks/${task.num}/lifecycle/${activation.id}.json`,
      );
      const lifecycle = JSON.parse(new TextDecoder().decode(bytes));
      const entries = lifecycle.entries.filter((entry) => entry.moment === 'onEnter');
      check(
        entries.length === 1 && entries[0].state === 'ok' && entries[0].runId === activation.runId,
        'Durable lifecycle did not preserve exactly one successful setup run',
      );
    }
    for (const id of [
      ...activations.map((entry) => entry.runId),
      ...gateRuns.map((run) => run.id),
      ...denied,
    ]) {
      const saved = await client.getProjectScriptRun('default', id);
      check(
        saved.status === (denied.includes(id) ? 'error' : 'ok') && !!saved.sourceHash,
        'Compiled script provenance or final audit was not durable',
      );
    }
  } finally {
    observe(async (_run) => {});
    store.completeTaskStep = complete;
  }
}
