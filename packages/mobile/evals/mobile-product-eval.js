/* Test-only source: packaged in androidTest / AppTests, never in the application. */
(() => {
  const clock = globalThis.__gezelMobileEvalClock;
  if (!clock) throw new Error('The shared eval awake clock must be loaded from the test bundle');
  const budgets = new WeakMap();
  const reports = new WeakMap();
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const now = () => new Date().toISOString();
  const scenarios = [
    'text-artifact',
    'scoped-read-write',
    'memory-recall',
    'script-transform',
    'crew-project-handoff',
    'gated-task',
    'interruption',
  ];
  const canonicalCoreCoverage = [
    ['tictactoe', 'HTML game runtime and browser gameplay grader'],
    ['petshop', 'Real native image generation engine and generate_image tool'],
    ['tankcombat', 'HTML game runtime and browser gameplay grader'],
    ['schema-migration', 'Unchanged host TypeScript/runtime grading of native workspace edits'],
    ['failing-tests-spec', 'Unchanged host acceptance/test grading of native workspace edits'],
    ['symptom-debug', 'Unchanged host acceptance/test grading of native workspace edits'],
    ['data-wrangle', 'Canonical workspace command/tool contract and host-side grading adapter'],
    ['incident-postmortem', 'Canonical evidence fixture and unchanged host-side grading adapter'],
    [
      'ops-runbook-anomaly',
      'Canonical ordered file reads, immutable evidence and stop-on-anomaly provenance',
    ],
    ['plan-and-estimate', 'Canonical direct plan-author brief and unchanged host plan grader'],
    [
      'conflict-synthesis',
      'Canonical source-provenance fixture and unchanged host-side grading adapter',
    ],
  ].map(([id, requirement]) => ({
    id,
    status: [
      'data-wrangle',
      'incident-postmortem',
      'conflict-synthesis',
      'tictactoe',
      'tankcombat',
      'schema-migration',
      'failing-tests-spec',
      'symptom-debug',
      'ops-runbook-anomaly',
      'plan-and-estimate',
    ].includes(id)
      ? 'not-run'
      : 'unsupported',
    requirement,
  }));
  async function api(path, method = 'GET', body = undefined, allowError = false) {
    const host = window.__GEZEL__;
    const response = await host.fetch(
      new Request(host.baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${host.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const value = await response.json();
    if (!response.ok && !allowError) throw new Error(`${path}: ${value.error || response.status}`);
    return allowError ? { status: response.status, value } : value;
  }
  const projectPath = (id) => `/api/projects/${encodeURIComponent(id)}`;
  const taskPath = (task) => `${projectPath(task.projectId)}/tasks/${task.num}`;
  const toolsIn = (sessions) =>
    sessions.flatMap((s) => s.messages.flatMap((m) => m.toolCalls || []));
  const used = (trial, name) => toolsIn(trial.sessions).some((t) => t.name === name && t.success);
  function assertion(trial, id, passed, evidence) {
    trial.assertions.push({ id, passed: Boolean(passed), evidence });
  }
  async function read(trial, area, path, projectId = trial.projectId) {
    const result = await api(
      `${projectPath(projectId)}/${area}/read?path=${encodeURIComponent(path)}`,
      'GET',
      undefined,
      true,
    );
    const content = result.status === 200 ? result.value.content : null;
    trial.artifacts.push({ projectId, area, path, content, status: result.status });
    return content;
  }
  async function seed(trial, path, content, projectId = trial.projectId) {
    await api(`${projectPath(projectId)}/workspace/write`, 'PUT', { path, content });
    trial.seeds.push({ projectId, path, content });
  }
  async function collect(trial) {
    const summaries = [];
    for (const id of trial.projectIds || [trial.projectId])
      summaries.push(...(await api(`/api/sessions?project=${encodeURIComponent(id)}`)).sessions);
    trial.sessions = await Promise.all(
      summaries
        .filter((s) => !trial.startedAt || s.createdAt >= trial.startedAt)
        .map((s) => api(`/api/sessions/${s.id}`)),
    );
  }
  async function snapshotTrial(trial, includeFiles = false) {
    trial.projects = (await api('/api/projects')).projects.filter(
      (p) => p.id === trial.projectId || !(trial.initialProjectIds || []).includes(p.id),
    );
    trial.projectIds = trial.projects.map((p) => p.id);
    trial.gezels = (await api('/api/gezels')).gezels;
    trial.questions = (await api('/api/questions?pending=true')).questions;
    trial.inflight = (await api('/api/sessions/inflight')).inflight;
    await collect(trial);
    trial.snapshotAt = now();
    if (!includeFiles) return;
    const artifacts = [];
    const errors = [];
    for (const project of trial.projects)
      for (const area of ['workspace', 'artifacts']) {
        let listing;
        try {
          listing = await api(`${projectPath(project.id)}/${area}?recursive=1&hidden=1`);
          if (listing.truncated) errors.push(`${project.id}/${area}: file listing truncated`);
        } catch (error) {
          errors.push(`${project.id}/${area}: ${String(error)}`);
          artifacts.push(
            ...trial.artifacts.filter((f) => f.projectId === project.id && f.area === area),
          );
          continue;
        }
        for (const file of listing.files.filter((f) => !f.isDirectory)) {
          const identity = { projectId: project.id, area, path: file.path };
          try {
            const host = window.__GEZEL__;
            const response = await host.fetch(
              new Request(
                `${host.baseUrl}${projectPath(project.id)}/${area}/read?raw=1&path=${encodeURIComponent(file.path)}`,
                { headers: { Authorization: `Bearer ${host.token}` } },
              ),
            );
            if (!response.ok) throw new Error(`read returned ${response.status}`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            let content = null;
            try {
              content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
            } catch {}
            let bytesBase64;
            if (content === null) {
              let binary = '';
              for (let at = 0; at < bytes.length; at += 8192)
                binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
              bytesBase64 = btoa(binary);
            }
            artifacts.push({
              ...identity,
              content,
              ...(bytesBase64 === undefined ? {} : { bytesBase64 }),
              byteLength: bytes.length,
              status: response.status,
            });
          } catch (error) {
            errors.push(`${project.id}/${area}/${file.path}: ${String(error)}`);
            const retained = trial.artifacts.find(
              (f) => f.projectId === project.id && f.area === area && f.path === file.path,
            );
            artifacts.push({
              ...identity,
              ...retained,
              content: retained?.content ?? null,
              captureError: String(error),
            });
          }
        }
      }
    trial.artifacts = artifacts;
    trial.evidenceCapturedAt = now();
    trial.evidenceCaptureErrors = errors;
    if (errors.length) throw new Error(`Incomplete native file evidence: ${errors.join('; ')}`);
  }
  async function ordinaryQuestionAssistance(trial) {
    const report = reports.get(trial);
    if (!report) throw new Error('Native assistance requires an active report');
    const requestId = `assistance-${crypto.randomUUID()}`;
    globalThis.__gezelMobileEvalGradeReceipt = null;
    trial.assistanceRequest = { id: requestId };
    report.revision++;
    const receiptBudget = new clock.AwakeBudget(Math.min(300000, budgets.get(trial).remainingMs()));
    while (
      globalThis.__gezelMobileEvalGradeReceipt?.requestId !== requestId &&
      !receiptBudget.expired()
    )
      await pause(200);
    const receipt = globalThis.__gezelMobileEvalGradeReceipt;
    delete trial.assistanceRequest;
    report.revision++;
    if (receipt?.requestId !== requestId)
      throw new Error('Host question helper did not return a matching receipt');
    if (receipt.error) throw new Error(`Host question helper failed: ${receipt.error}`);
    if (!Array.isArray(receipt.assistance?.actions))
      throw new Error('Invalid ordinary-question receipt');
    if (receipt.assistance.actions.length) trial.assistanceHistory.push(receipt);
    for (const action of receipt.assistance.actions) {
      const session = trial.sessions.find(
        (s) =>
          s.id === action.sessionId &&
          s.gezelId === action.gezelId &&
          s.projectId === action.projectId,
      );
      if (!session)
        throw new Error('Question helper recipient is outside the retained native snapshot');
      if (action.kind === 'answerQuestion') {
        const question = trial.questions.find(
          (q) =>
            q.id === action.questionId &&
            q.sessionId === session.id &&
            q.gezelId === session.gezelId &&
            q.projectId === session.projectId,
        );
        if (!question || question.answer || question.intent)
          throw new Error('Question helper may only answer ordinary pending product questions');
        await api(`/api/questions/${encodeURIComponent(question.id)}/answer`, 'POST', action.body);
      } else if (action.kind === 'sendChatMessage') {
        if (session.gezelId !== trial.meesterId || session.projectId !== 'default')
          throw new Error('Inline assistance requires the retained Meester front-door session');
        await api(`/api/sessions/${session.id}/send`, 'POST', action.body);
      } else throw new Error('Unknown ordinary-question operation');
      const event = {
        atMs: trial.budgetMs - budgets.get(trial).remainingMs(),
        kind: action.kind === 'answerQuestion' ? 'structured' : 'inline',
        gezel: action.gezelId,
        question: action.question,
        chose: JSON.stringify(action.body),
        requestId,
        sessionId: session.id,
        questionId: action.questionId,
      };
      trial.autoAnswers.push(event);
      trial.prompts.push({ ...action, at: now(), source: 'shared-eval-auto-answer' });
      report.revision++;
    }
    return receipt.assistance.actions.length > 0;
  }
  function transformedRecordIsCorrect(value) {
    const records = value?.records;
    const record = records?.['repair-17'];
    return (
      value?.version === 1 &&
      records &&
      Object.keys(records).length === 1 &&
      record &&
      Object.keys(record).length === 3 &&
      record.item === 'lamp' &&
      record.status === 'repaired' &&
      record.count === 3
    );
  }
  async function idle(trial) {
    let settled = 0;
    while (!budgets.get(trial).expired()) {
      const sessions = (await api('/api/sessions/inflight')).inflight;
      if (!sessions.length) {
        if (++settled >= 5) {
          await snapshotTrial(trial);
          if (await ordinaryQuestionAssistance(trial)) settled = 0;
          else return;
        }
      } else settled = 0;
      await pause(200);
    }
    for (const item of (await api('/api/sessions/inflight')).inflight)
      await api(`/api/sessions/${item.sessionId}/cancel`, 'POST', {});
    await collect(trial);
    throw new Error(
      `The trial exhausted its declared awake-time budget${budgets.get(trial).describeSuspension()}`,
    );
  }
  async function send(trial, message, gezelId = trial.gezelId) {
    const session = await api('/api/sessions', 'POST', { gezelId, projectId: trial.projectId });
    trial.prompts.push({ sessionId: session.id, gezelId, message, at: now() });
    await api(`/api/sessions/${session.id}/send`, 'POST', { message });
    await idle(trial);
    return api(`/api/sessions/${session.id}`);
  }
  const cases = {
    async 'text-artifact'(t) {
      await seed(
        t,
        'brief.md',
        '# Repair day\nDate: 18 October 2026\nVenue: Maple Hall\nBudget: 240 euros\nLead: Noor\nBring: broken lamps and small appliances\nChildren must be accompanied by an adult.\n',
      );
      await send(
        t,
        'Read brief.md and create announcement.md in the project artifacts. Write a friendly announcement under 200 words that preserves the date, venue, budget, lead, items to bring and child supervision rule. Do not invent extra details.',
      );
      const text = (await read(t, 'artifacts', 'announcement.md')) || '';
      assertion(
        t,
        'facts-preserved',
        ['18 October 2026', 'Maple Hall', '240', 'Noor', 'lamps', 'appliances', 'adult'].every(
          (s) => text.toLowerCase().includes(s.toLowerCase()),
        ),
        text,
      );
      assertion(
        t,
        'concise-nonempty-announcement',
        text.trim().split(/\s+/).length >= 25 && text.trim().split(/\s+/).length <= 200,
        { words: text.trim().split(/\s+/).length },
      );
      assertion(
        t,
        'source-read-and-artifact-written',
        used(t, 'read_file') && used(t, 'write_artifact'),
        toolsIn(t.sessions),
      );
    },
    async 'scoped-read-write'(t) {
      await seed(t, 'inputs/counts.csv', 'name,count\nAda,12\nBert,7\nCora,9\n');
      const privateProject = await api('/api/projects', 'POST', {
        name: 'Other eval workspace',
        indexingEnabled: false,
      });
      await seed(t, 'private.txt', 'PRIVATE-SCOPE-MARKER-9217', privateProject.id);
      await send(
        t,
        'Read inputs/counts.csv in this project. Write result.json in this project workspace with exactly these fields: total (sum of count), largestName (name with the largest count), and rowCount (number of data rows). Work only in this project.',
      );
      const content = await read(t, 'workspace', 'result.json');
      let result;
      try {
        result = JSON.parse(content || '');
      } catch {
        result = null;
      }
      assertion(
        t,
        'correct-transform',
        result?.total === 28 && result?.largestName === 'Ada' && result?.rowCount === 3,
        result,
      );
      const escapeResult = await api(
        `${projectPath(t.projectId)}/workspace/read?path=..%2F..%2F${privateProject.id}%2Fworkspace%2Fprivate.txt`,
        'GET',
        undefined,
        true,
      );
      assertion(t, 'path-escape-refused', escapeResult.status >= 400, escapeResult);
      const original = await read(t, 'workspace', 'private.txt', privateProject.id);
      assertion(t, 'other-project-unchanged', original === 'PRIVATE-SCOPE-MARKER-9217', original);
      assertion(
        t,
        'real-scoped-file-tools',
        used(t, 'read_file') && used(t, 'write_file'),
        toolsIn(t.sessions),
      );
    },
    async 'memory-recall'(t) {
      await send(
        t,
        'Remember this durable project decision: the repair cabinet access phrase is ORCHARD-7284 and Noor is the person responsible. Save it to project memory.',
      );
      const recalled = await send(
        t,
        'Find the saved project decision about the repair cabinet. Create cabinet-note.md in the artifacts with its exact access phrase and the responsible person.',
      );
      const text = (await read(t, 'artifacts', 'cabinet-note.md')) || '';
      assertion(
        t,
        'fresh-session-recall',
        text.includes('ORCHARD-7284') && text.includes('Noor'),
        text,
      );
      assertion(
        t,
        'memory-written-and-searched',
        used(t, 'save_memory') && used(t, 'search_memory'),
        toolsIn(t.sessions),
      );
      assertion(
        t,
        'recall-prompt-does-not-contain-answer',
        !recalled.messages.find((m) => m.role === 'user')?.content.includes('ORCHARD-7284'),
        recalled.id,
      );
      t.memory = await api('/api/memory/search', 'POST', {
        gezelId: t.gezelId,
        projectId: t.projectId,
        query: 'ORCHARD-7284',
      });
    },
    async 'script-transform'(t) {
      await send(
        t,
        'Use the bundled storeRecords script to create record repair-17 in workspace file repairs.json using single-file storage (root repairs). Set fields to {"item":"lamp","status":"received","count":3}. Then use the same script to update the status of that record to "repaired", keeping its other fields. Find the script input instructions first. Do not write or edit the generated JSON by hand.',
      );
      const content = (await read(t, 'workspace', 'repairs.json')) || '';
      let value;
      try {
        value = JSON.parse(content);
      } catch {
        value = null;
      }
      const calls = toolsIn(t.sessions).filter(
        (call) => call.name === 'run_installed_script' && call.success,
      );
      assertion(
        t,
        'script-created-and-transformed-record',
        transformedRecordIsCorrect(value),
        value,
      );
      assertion(
        t,
        'two-script-executions-no-handwritten-substitute',
        calls.length >= 2 &&
          !['write_file', 'append_to_file', 'replace_in_file', 'replace_lines'].some((name) =>
            used(t, name),
          ),
        calls,
      );
      t.scriptRuns = [];
      for (const call of calls) {
        let result;
        try {
          result = JSON.parse(call.resultText);
        } catch {
          continue;
        }
        const id = result.runId || result.id;
        if (id) t.scriptRuns.push(await api(`${projectPath(t.projectId)}/script-runs/${id}`));
      }
      assertion(
        t,
        'persistent-successful-script-audit',
        t.scriptRuns.length >= 2 &&
          t.scriptRuns.every((run) => run.status === 'ok' && run.calls?.length),
        t.scriptRuns,
      );
    },
    async 'crew-project-handoff'(t) {
      const teammate = await api('/api/gezels', 'POST', {
        name: 'Eval colleague',
        role: 'Generalist',
      });
      await api(`${projectPath(t.projectId)}/gezels`, 'POST', { gezelId: teammate.id });
      await seed(
        t,
        'crew-brief.md',
        'Repair team: Noor, Ada, Bert.\nMeeting: Thursday at 14:30.\nLocation: Maple Hall.\n',
      );
      await send(
        t,
        `Ask your project colleague ${teammate.name} (id ${teammate.id}) to read crew-brief.md and produce crew-note.md in this project's artifacts with all three team members, the meeting time, day and location. Hand off the work to the colleague and let them produce the file.`,
      );
      const text = (await read(t, 'artifacts', 'crew-note.md')) || '';
      const delegate = t.sessions.filter((s) => s.gezelId === teammate.id);
      assertion(
        t,
        'handoff-used-and-colleague-ran',
        used(t, 'message_gezel') && delegate.length > 0,
        delegate,
      );
      assertion(
        t,
        'colleague-produced-complete-artifact',
        ['Noor', 'Ada', 'Bert', 'Thursday', '14:30', 'Maple Hall'].every((s) => text.includes(s)) &&
          toolsIn(delegate).some((call) => call.name === 'write_artifact' && call.success),
        text,
      );
      t.expectedGezelIds = [t.gezelId, teammate.id];
    },
    async 'gated-task'(t) {
      const task = await api(`${projectPath(t.projectId)}/tasks`, 'POST', {
        title: 'Prepare repair handover',
        description:
          'Create a repair handover artifact recording who owns the repair cabinet and its opening time.',
        status: 'draft',
        assignee: { kind: 'gezel', gezelId: t.gezelId },
        steps: [
          {
            id: 'write',
            name: 'Write handover',
            prompt:
              'Write handover.md in the artifacts: Noor owns the repair cabinet and opens it at 09:30 on Monday. Then complete this task step.',
            terminal: true,
            gate: {
              at: 'completion',
              checks: [
                { kind: 'minBytes', file: 'handover.md', artifact: true, bytes: 40 },
                { kind: 'sniff', file: 'handover.md', artifact: true, sniff: 'nonempty' },
              ],
            },
          },
        ],
      });
      await api(`${taskPath(task)}/status`, 'POST', { status: 'active' });
      const premature = await api(
        `${taskPath(task)}/steps/${task.activeStepId}/complete`,
        'POST',
        {},
        true,
      );
      const before = await api(taskPath(task));
      assertion(
        t,
        'missing-deliverable-does-not-complete',
        before.status !== 'complete' &&
          premature.value.gate?.decision === 'reject' &&
          !premature.value.gate.infrastructureError,
        premature,
      );
      await api(`${taskPath(task)}/activate`, 'POST', {});
      await idle(t);
      t.task = await api(taskPath(task));
      const text = (await read(t, 'artifacts', 'handover.md')) || '';
      assertion(
        t,
        'task-deliverable-correct',
        ['Noor', '09:30', 'Monday'].every((s) => text.includes(s)),
        text,
      );
      assertion(
        t,
        'gate-approved-and-task-complete',
        t.task.status === 'complete' &&
          Boolean(t.task.craftbook.steps.find((s) => s.id === 'write')?.completedAt),
        t.task,
      );
      assertion(
        t,
        'model-used-task-tools',
        used(t, 'write_artifact') && used(t, 'advance_task_step'),
        toolsIn(t.sessions),
      );
    },
    async interruption(t) {
      const session = await api('/api/sessions', 'POST', {
        gezelId: t.gezelId,
        projectId: t.projectId,
      });
      const message =
        'Write a detailed fictional journal of a repair workshop, covering every day of an entire year. Begin now and continue with as much detail as possible. Do not use tools.';
      t.prompts.push({ sessionId: session.id, gezelId: t.gezelId, message, at: now() });
      const deltaBefore = t.nativeDeltas;
      await api(`/api/sessions/${session.id}/send`, 'POST', { message });
      while (!budgets.get(t).expired() && t.nativeDeltas === deltaBefore) {
        if (!(await api(`/api/sessions/${session.id}/inflight`)).inflight) break;
        await pause(30);
      }
      const started = clock.awakeNow();
      const cancel = await api(`/api/sessions/${session.id}/cancel`, 'POST', {});
      await idle(t);
      const stopped = await api(`/api/sessions/${session.id}`);
      t.cancellationLatencyMs = clock.awakeNow() - started;
      assertion(t, 'cancelled-real-stream', t.nativeDeltas > deltaBefore && cancel.cancelled, {
        nativeDeltas: t.nativeDeltas - deltaBefore,
        cancel,
      });
      assertion(
        t,
        'interruption-persisted',
        !stopped.turnStartedAt &&
          stopped.messages.some(
            (m) =>
              m.role === 'assistant' && m.status === 'interrupted' && m.stopReason === 'cancelled',
          ),
        stopped,
      );
      const followup = await send(t, 'Reply with the word READY.');
      assertion(
        t,
        'provider-reusable-after-stop',
        !followup.lastTurnError &&
          followup.messages.some(
            (m) => m.role === 'assistant' && m.status === 'complete' && /READY/i.test(m.content),
          ),
        followup,
      );
    },
  };
  async function withContractProvider(result, runContract, phase = '') {
    const check = (id, passed, evidence) => assertion(result, id, passed, evidence);
    const capacitor = window.Capacitor;
    const original = capacitor.nativePromise;
    const providerId =
      capacitor.getPlatform() === 'ios' ? 'apple-foundation-models' : 'android-mlkit';
    const requests = [];
    const queued = [];
    result.mechanics ??= {
      completionSource: 'deterministic-native-boundary-fixture',
      nativeModelInference: false,
    };
    // This override exists only in the separately injected test bundle. All client
    // routes, policies, task scheduling and native filesystem calls remain real.
    // Unplanned generation fails closed instead of reaching a real model.
    capacitor.nativePromise = function (pluginName, method, options) {
      if (pluginName === 'GezelMobile' && method === 'providers') {
        return Promise.resolve({
          providers: [
            {
              id: providerId,
              name: 'Contract fixture',
              locality: 'on-device',
              availability: 'available',
              contextTokens: 4096,
              maxOutputTokens: 1024,
              capabilities: {
                text: true,
                tools: false,
                structuredOutput: false,
                images: false,
                foregroundOnly: true,
              },
            },
          ],
        });
      }
      if (pluginName === 'GezelMobile' && method === 'generate') {
        requests.push(options);
        const text = queued.shift();
        if (text === undefined) return Promise.reject(new Error('Unexpected contract generation'));
        return Promise.resolve({ text, stopReason: 'stop' });
      }
      return original.call(this, pluginName, method, options);
    };
    const settle = async () => {
      for (let attempt = 0, quiet = 0; attempt < 600; attempt++) {
        if ((await api('/api/sessions/inflight')).inflight.length === 0) {
          if (++quiet >= 5) return;
        } else quiet = 0;
        await pause(100);
      }
      throw new Error('Deterministic product turn did not settle');
    };
    const completion = (name, args) => JSON.stringify({ name, arguments: args });
    try {
      await runContract({ check, requests, queued, settle, completion });
    } catch (error) {
      check(`${phase}product-mechanics-finished`, false, String(error.stack || error));
    } finally {
      try {
        for (const item of (await api('/api/sessions/inflight')).inflight)
          await api(`/api/sessions/${item.sessionId}/cancel`, 'POST', {});
      } finally {
        capacitor.nativePromise = original;
      }
    }
    check(`${phase}native-provider-boundary-restored`, capacitor.nativePromise === original, {
      nativeModelInference: false,
    });
  }
  async function productMechanicsContracts(result, recipient) {
    await withContractProvider(result, async ({ check, requests, queued, settle, completion }) => {
      const config = await api('/api/config');
      const body = {
        fromGezelId: config.meesterGezelId,
        projectId: result.projectId,
        text: 'Correct the reported result.',
        suppressReply: true,
      };
      queued.push('Saved response');
      const first = await api(`/api/gezels/${recipient.id}/message`, 'POST', body);
      await settle();
      const hint = {
        kind: 'repair-file',
        path: 'output/report.json',
        mutationPath: 'src/report.ts',
        readPaths: ['src/report.ts'],
        strategy: 'patch',
      };
      const expected = { kind: 'file', filePath: 'output/report.json' };
      queued.push('Saved response');
      const second = await api(`/api/gezels/${recipient.id}/message`, 'POST', {
        ...body,
        fileTurnIntent: hint,
        expectedDeliverable: expected,
      });
      await settle();
      const session = await api(`/api/sessions/${second.sessionId}`);
      const user = session.messages.filter((message) => message.role === 'user').at(-1);
      const prompt = requests.at(-1)?.messages.at(-1)?.content || '';
      check(
        'crew-message-retains-session-and-file-intent',
        first.sessionId === second.sessionId &&
          second.deliveryState === 'dispatched' &&
          Object.entries(hint).every(
            ([key, value]) => JSON.stringify(user?.fileTurnIntent?.[key]) === JSON.stringify(value),
          ) &&
          user?.from?.gezelId === config.meesterGezelId &&
          JSON.stringify(session.expectedDeliverable) === JSON.stringify(expected) &&
          prompt.includes('grants no additional filesystem or tool access'),
        { first, second, user, expectedDeliverable: session.expectedDeliverable, prompt },
      );
      result.mechanics.messageSessionId = second.sessionId;
      result.mechanics.fileTurnIntent = hint;
      queued.push('The saved result is ready.');
      await api(`/api/sessions/${second.sessionId}/send`, 'POST', {
        message: 'Explain the saved result.',
      });
      await settle();
      check(
        'repair-intent-does-not-leak-to-next-turn',
        !requests.at(-1)?.messages.at(-1)?.content.includes('mutationPath') &&
          requests.length === 3,
        requests.map((request) => request.messages.at(-1)),
      );
      await api(`${projectPath(result.projectId)}/workspace/write`, 'PUT', {
        path: 'targeted.txt',
        content: 'First\nSecond\n',
      });
      const fileSession = await api('/api/sessions', 'POST', {
        gezelId: recipient.id,
        projectId: result.projectId,
      });
      queued.push(
        completion('append_to_file', { path: 'targeted.txt', content: 'Third\n' }),
        completion('replace_in_file', {
          path: 'targeted.txt',
          find: 'Second',
          replace: 'Reviewed',
        }),
        'The file is updated.',
      );
      await api(`/api/sessions/${fileSession.id}/send`, 'POST', {
        message:
          'Append Third to targeted.txt, then replace Second with Reviewed using targeted edits.',
      });
      await settle();
      const edited = await api(`/api/sessions/${fileSession.id}`);
      const content = await read(result, 'workspace', 'targeted.txt');
      const calls = toolsIn([edited]);
      check(
        'targeted-edits-use-real-scoped-storage',
        content === 'First\nReviewed\nThird\n' &&
          ['append_to_file', 'replace_in_file'].every((name) =>
            calls.some((call) => call.name === name && call.success),
          ),
        { content, calls },
      );
      await api('/api/config', 'PUT', { generalistMode: 'on' });
      const task = await api(`${projectPath(result.projectId)}/tasks`, 'POST', {
        title: 'Prepare and review',
        description: 'Prepare a short report and review the completed report.',
        steps: [
          { name: 'Prepare', suggestedRole: 'Developer' },
          { name: 'Review', suggestedRole: 'Reviewer', terminal: true },
        ],
      });
      const beforeTask = requests.length;
      queued.push(
        completion('advance_task_step', { ref: task.ref }),
        completion('advance_task_step', { ref: task.ref }),
      );
      await api(`${taskPath(task)}/retry`, 'POST', {});
      // Inflight sessions may briefly be empty between scheduled task steps.
      // Wait for the task's terminal state before checking transcript persistence.
      for (let attempt = 0; attempt < 300; attempt++) {
        if ((await api(taskPath(task))).status === 'complete') break;
        await pause(100);
      }
      await settle();
      const completed = await api(taskPath(task));
      const summaries = (await api(`${taskPath(task)}/sessions`)).sessions;
      const transcript =
        summaries.length === 1 ? await api(`/api/sessions/${summaries[0].id}`) : null;
      const taskRequests = requests.slice(beforeTask);
      check(
        'generalist-carries-one-transcript-across-steps',
        completed.status === 'complete' &&
          completed.executionMode === 'generalist' &&
          transcript?.messages.filter((message) => message.role === 'user').length === 2 &&
          transcript.stepId === completed.craftbook.steps[1].id &&
          taskRequests.length === 2 &&
          taskRequests[1].messages.filter((message) => message.role === 'assistant').length === 1 &&
          taskRequests[1].messages[0].content.includes('### Task outline'),
        {
          task: completed,
          sessions: summaries,
          messages: transcript?.messages,
          requestCount: taskRequests.length,
        },
      );
      result.mechanics.task = {
        projectId: task.projectId,
        num: task.num,
        sessionId: transcript?.id,
      };
      const sessionsBefore = (await api('/api/sessions')).sessions.map((item) => item.id).sort();
      queued.push('A clearer local sentence.');
      const host = window.__GEZEL__;
      const transformed = await host.fetch(
        new Request(`${host.baseUrl}/api/ai/transform`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${host.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: 'rewrite',
            text: 'An unclear local sentence.',
            instruction: 'Make it clearer.',
          }),
        }),
      );
      const events = (await transformed.text())
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)));
      await settle();
      const sessionsAfter = (await api('/api/sessions')).sessions.map((item) => item.id).sort();
      check(
        'text-transform-stream-completes-without-chat',
        transformed.ok &&
          events.some(
            (event) => event.type === 'done' && event.text === 'A clearer local sentence.',
          ) &&
          !events.some((event) => event.type === 'error') &&
          JSON.stringify(sessionsBefore) === JSON.stringify(sessionsAfter),
        { events, sessionsBefore, sessionsAfter },
      );
      check('contract-completions-consumed-exactly', queued.length === 0 && requests.length === 9, {
        requests: requests.length,
        queued: queued.length,
        completionSource: result.mechanics.completionSource,
      });
      const draftTask = await api(`${projectPath(result.projectId)}/tasks`, 'POST', {
        title: 'Preserve task message',
        description: 'Keep this task message saved until it is ready to send.',
        assignee: { kind: 'gezel', gezelId: recipient.id },
        steps: [{ name: 'Prepare', terminal: true }],
      });
      const draftSession = await api('/api/sessions', 'POST', {
        gezelId: recipient.id,
        projectId: result.projectId,
        taskRef: draftTask.ref,
        stepId: draftTask.activeStepId,
      });
      const draft = await api(`${projectPath(result.projectId)}/prompt-drafts`, 'POST', {
        gezelId: recipient.id,
        taskRef: draftTask.ref,
        sessionId: draftSession.id,
        scope: 'task',
        content: 'Please use the saved project brief.',
      });
      result.taskDraft = {
        id: draft.id,
        taskRef: draftTask.ref,
        sessionId: draftSession.id,
        gezelId: recipient.id,
        content: draft.content,
      };
      check(
        'task-draft-created',
        draft.taskRef === draftTask.ref &&
          draft.scope === 'task' &&
          draft.status === 'draft' &&
          requests.length === 9 &&
          queued.length === 0,
        draft,
      );
    });
  }
  async function finishTaskDraftContracts(result) {
    await withContractProvider(
      result,
      async ({ check, requests, queued, settle }) => {
        const identity = result.taskDraft;
        if (!identity) throw new Error('Task draft was not created before reload');
        const path = `${projectPath(result.projectId)}/prompt-drafts/${encodeURIComponent(identity.id)}`;
        const saved = await api(path);
        const copy = await api(`${path}/duplicate`, 'POST', { sessionId: null });
        result.taskDraft.copyId = copy.id;
        check(
          'task-draft-reopened-and-duplicated',
          saved.taskRef === identity.taskRef &&
            saved.scope === 'task' &&
            saved.content === identity.content &&
            copy.taskRef === saved.taskRef &&
            copy.scope === saved.scope &&
            copy.sessionId === null &&
            copy.content === saved.content,
          { saved, copy },
        );
        const rejectedPatch = await api(path, 'PATCH', { sessionId: result.sessionId }, true);
        const rejectedSend = await api(
          `/api/sessions/${result.sessionId}/send`,
          'POST',
          { message: saved.content, draftId: saved.id },
          true,
        );
        const afterRejection = await api(path);
        const unrelated = await api(`/api/sessions/${result.sessionId}`);
        const beforeSend = requests.length;
        queued.push('The saved task brief is ready.');
        const accepted = await api(`/api/sessions/${identity.sessionId}/send`, 'POST', {
          message: saved.content,
          draftId: saved.id,
        });
        await settle();
        const sent = await api(path);
        const session = await api(`/api/sessions/${identity.sessionId}`);
        result.sessions.push(session);
        check(
          'task-draft-wrong-context-rejected-and-sent',
          rejectedPatch.status === 400 &&
            rejectedSend.status === 409 &&
            afterRejection.status === 'draft' &&
            unrelated.messages.length === 0 &&
            beforeSend === 0 &&
            accepted.accepted &&
            sent.status === 'sent' &&
            requests.length === 1 &&
            queued.length === 0 &&
            session.taskRef === identity.taskRef &&
            session.messages.some((m) => m.role === 'user' && m.content === identity.content),
          { rejectedPatch, rejectedSend, afterRejection, sent, session, requests: requests.length },
        );
      },
      'task-draft-',
    );
  }
  async function prepareContracts() {
    const result = {
      id: 'native-contracts',
      assertions: [],
      artifacts: [],
      sessions: [],
      passed: false,
    };
    const check = (id, passed, evidence) => assertion(result, id, passed, evidence);
    // Session creation pins an actual provider, even though silent question dismissal
    // deliberately performs no inference. Select the platform's ordinary provider
    // through the same configuration route as Settings in this isolated test store.
    await api('/api/config', 'PUT', {
      provider:
        globalThis.Capacitor.getPlatform() === 'ios' ? 'apple-foundation-models' : 'android-mlkit',
    });
    const project = await api('/api/projects', 'POST', {
      name: 'Contract workshop',
      indexingEnabled: false,
    });
    result.projectId = project.id;
    const source =
      "import { defineScript, gezel } from '@bendyline/gezel-sdk';\nexport const meta = defineScript({name:'saveLocal',description:'Write a local verification artifact',requires:['artifacts.write'],outputs:{ok:{type:'boolean',description:'Saved'}}} as const);\nawait gezel.artifacts.write('authored.txt','offline compiler and QuickJS');\ngezel.output({ok:true});\n";
    const created = await api(`${projectPath(project.id)}/scripts`, 'POST', {
      name: 'saveLocal',
      source,
    });
    const invalid = await api(`${projectPath(project.id)}/scripts/source`, 'PUT', {
      name: 'saveLocal',
      source: `${source}\nconst broken: = ;`,
      baseHash: created.hash,
    });
    check(
      'compiler-reports-invalid-typescript',
      invalid.status === 'saved' && invalid.diagnostics?.some((d) => d.severity === 'error'),
      invalid,
    );
    const saved = await api(`${projectPath(project.id)}/scripts/source`, 'PUT', {
      name: 'saveLocal',
      source,
      baseHash: invalid.hash,
    });
    check(
      'valid-source-saved',
      saved.status === 'saved' &&
        saved.metaOk &&
        !saved.diagnostics?.some((d) => d.severity === 'error'),
      saved,
    );
    const run = await api(`${projectPath(project.id)}/scripts/run`, 'POST', {
      name: 'saveLocal',
      scope: 'project',
      input: {},
    });
    result.script = { name: 'saveLocal', source, hash: saved.hash, runId: run.runId };
    check('authored-quickjs-executed', run.status === 'ok' && run.output?.ok === true, run);
    const text = await read(result, 'artifacts', 'authored.txt');
    check('authored-script-wrote-real-artifact', text === 'offline compiler and QuickJS', text);
    const gezel = await api('/api/gezels', 'POST', {
      name: 'Contract companion',
      role: 'Generalist',
    });
    await api(`${projectPath(project.id)}/gezels`, 'POST', { gezelId: gezel.id });
    await productMechanicsContracts(result, gezel);
    const session = await api('/api/sessions', 'POST', {
      gezelId: gezel.id,
      projectId: project.id,
    });
    result.sessionId = session.id;
    const question = await api('/api/questions', 'POST', {
      projectId: project.id,
      gezelId: gezel.id,
      sessionId: session.id,
      prompt: 'Which report format?',
      choices: ['Short', 'Detailed'],
      allowWriteIn: true,
    });
    result.questionId = question.questionId;
    return result;
  }
  async function finishContracts(result) {
    await finishTaskDraftContracts(result);
    const until = async (fn, label) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const value = await fn();
        if (value) return value;
        await pause(100);
      }
      throw new Error(`Shared UI did not show ${label}`);
    };
    const source = await api(`${projectPath(result.projectId)}/scripts/source?name=saveLocal`);
    assertion(
      result,
      'authored-source-reopened',
      source.source === result.script.source && source.hash === result.script.hash,
      source,
    );
    const record = await api(`${projectPath(result.projectId)}/script-runs/${result.script.runId}`);
    assertion(
      result,
      'authored-audit-reopened',
      record.status === 'ok' && record.calls?.length > 0,
      record,
    );
    if (result.mechanics?.messageSessionId) {
      const saved = await api(`/api/sessions/${result.mechanics.messageSessionId}`);
      assertion(
        result,
        'crew-message-metadata-reopened',
        saved.messages.some((message) =>
          Object.entries(result.mechanics.fileTurnIntent).every(
            ([key, value]) =>
              JSON.stringify(message.fileTurnIntent?.[key]) === JSON.stringify(value),
          ),
        ),
        saved.messages,
      );
    }
    if (result.mechanics?.task) {
      const task = await api(taskPath(result.mechanics.task));
      const sessions = (await api(`${taskPath(task)}/sessions`)).sessions;
      assertion(
        result,
        'generalist-task-continuity-reopened',
        task.status === 'complete' &&
          task.executionMode === 'generalist' &&
          sessions.length === 1 &&
          sessions[0].id === result.mechanics.task.sessionId,
        { task, sessions },
      );
    }
    const navigation = [...document.querySelectorAll('button')].find(
      (button) => button.textContent.trim() === 'Navigation' && button.getClientRects().length,
    );
    navigation?.click();
    const open = await until(
      () =>
        [...document.querySelectorAll('button')].find(
          (button) =>
            /Resolve .* pending question/.test(button.getAttribute('aria-label') || '') &&
            (button.getAttribute('aria-label') || '').includes('Contract workshop'),
        ),
      'project question affordance',
    );
    open.click();
    const card = await until(
      () =>
        [...document.querySelectorAll('.pending-question-pending')].find((element) =>
          element.textContent.includes('Which report format?'),
        ),
      'restored question card',
    );
    const skip = await until(
      () =>
        [...card.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Skip'),
      'Skip action',
    );
    const bounds = await until(() => {
      const rect = skip.getBoundingClientRect();
      return rect.width >= 44 &&
        rect.height >= 44 &&
        rect.left >= -1 &&
        rect.right <= innerWidth + 1 &&
        rect.top >= -1 &&
        rect.bottom <= innerHeight + 1
        ? rect
        : null;
    }, 'fully visible 44px Skip action after the opening animation');
    assertion(
      result,
      'question-skip-visible',
      bounds.width >= 44 &&
        bounds.height >= 44 &&
        bounds.left >= -1 &&
        bounds.right <= innerWidth + 1 &&
        bounds.top >= -1 &&
        bounds.bottom <= innerHeight + 1,
      {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height,
      },
    );
    skip.click();
    const answered = await until(
      async () =>
        (
          await api(`/api/questions?project=${encodeURIComponent(result.projectId)}`)
        ).questions.find((q) => q.id === result.questionId && q.answer?.silentSkip),
      'persisted silent skip',
    );
    const session = await api(`/api/sessions/${result.sessionId}`);
    result.sessions.push(session);
    assertion(
      result,
      'silent-skip-started-no-model-turn',
      Boolean(answered.answer?.silentSkip) &&
        !session.turnStartedAt &&
        session.messages.length === 0,
      session,
    );
    result.passed = result.assertions.every((a) => a.passed);
    return result;
  }
  async function run(options) {
    if (!window.Capacitor?.isNativePlatform())
      throw new Error('Quality evals require a packaged native app');
    const plugin = window.Capacitor.Plugins.GezelMobile;
    const providers = (await plugin.providers()).providers;
    const inventory = await plugin.listModels();
    const provider = providers.find((p) => p.id === options.provider);
    const fixtures = options.canonicalFixtures || [];
    const requested = options.scenarios || [...scenarios, ...fixtures.map((f) => f.id)];
    const report = {
      schemaVersion: 1,
      suite: options.contractsOnly ? 'mobile-contracts' : 'mobile-product-v1',
      runId: options.runId,
      startedAt: now(),
      identity: {
        ...options.identity,
        userAgent: navigator.userAgent,
        platform: window.Capacitor.getPlatform(),
        provider,
        model:
          options.provider === 'llama-cpp'
            ? inventory.models.find((m) => m.id === inventory.selectedModelId)
            : { id: options.provider },
        configuration: {
          maxTokens:
            options.maxTokens ??
            Math.min(
              1024,
              provider?.maxOutputTokens ?? 1024,
              Math.floor(
                (options.contextSize ?? Math.min(4096, provider?.contextTokens ?? 4096)) / 4,
              ),
            ),
          contextSize: options.contextSize ?? Math.min(4096, provider?.contextTokens ?? 4096),
        },
      },
      canonicalCoreCoverage: canonicalCoreCoverage.map((entry) => ({ ...entry })),
      canonicalMode:
        'Unchanged canonical setup, host graders and canonical feedback; all generation and file effects run in the packaged native product. Host grading uses frozen device snapshots.',
      trials: [],
      contracts: options.contracts,
      revision: 0,
      complete: false,
    };
    globalThis.__gezelMobileEvalReport = report;
    if (options.contracts) {
      clock.startSuspendMonitor();
      const contractArtifact = options.contracts.artifacts.find(
        (file) => file.path === 'authored.txt',
      );
      if (contractArtifact?.content) {
        const requestId = `contract-${crypto.randomUUID()}`;
        report.contracts.mailboxRequest = { id: requestId, content: contractArtifact.content };
        globalThis.__gezelMobileEvalGradeReceipt = null;
        report.revision++;
        const receiptBudget = new clock.AwakeBudget(60000);
        while (
          globalThis.__gezelMobileEvalGradeReceipt?.requestId !== requestId &&
          !receiptBudget.expired()
        )
          await pause(200);
        const receipt = globalThis.__gezelMobileEvalGradeReceipt;
        const digest = [
          ...new Uint8Array(
            await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(contractArtifact.content),
            ),
          ),
        ]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        assertion(
          report.contracts,
          'native-host-grading-mailbox',
          receipt?.requestId === requestId && receipt.artifactSha256 === digest,
          { requestId, artifactSha256: receipt?.artifactSha256 },
        );
        report.contracts.passed =
          report.contracts.passed && report.contracts.assertions.every((item) => item.passed);
        delete report.contracts.mailboxRequest;
        report.revision++;
      }
    }

    if (!provider || provider.availability !== 'available') {
      report.trials = requested.map((id) => ({
        id,
        suite: fixtures.some((fixture) => fixture.id === id)
          ? 'canonical-core-native'
          : 'mobile-product-v1',
        status: 'blocked',
        assertions: [],
        error: provider?.reason || 'Requested provider is unavailable',
        sessions: [],
        artifacts: [],
      }));
      for (const entry of report.canonicalCoreCoverage)
        if (requested.includes(entry.id)) entry.status = 'blocked';
      report.complete = true;
      report.finishedAt = now();
      report.revision++;
      return report;
    }
    const modelId = report.identity.model?.id;
    if (!modelId) throw new Error('No selected trained model');
    clock.startSuspendMonitor();
    await api('/api/config', 'PUT', {
      provider: options.provider,
      modelContextOverrides: {
        [`${options.provider}:${modelId}`]: report.identity.configuration.contextSize,
      },
      modelTuning: {
        [modelId]: { sampling: { maxTokens: report.identity.configuration.maxTokens } },
      },
    });
    for (const id of requested) {
      const fixture = fixtures.find((f) => f.id === id);
      if (!cases[id] && !fixture) throw new Error(`Unknown mobile scenario: ${id}`);
      const started = clock.awakeNow();
      const wallStarted = Date.now();
      const budget = fixture?.timeoutMs || options.trialTimeoutMs || 180000;
      const trial = {
        id,
        suite: fixture ? 'canonical-core-native' : 'mobile-product-v1',
        status: 'running',
        startedAt: now(),
        budgetMs: budget,
        assertions: [],
        seeds: [],
        prompts: [],
        sessions: [],
        artifacts: [],
        autoAnswers: [],
        assistanceHistory: [],
        meesterId: (await api('/api/config')).meesterGezelId,
        nativeDeltas: 0,
        firstNativeDeltaMs: null,
      };
      const budgetClock = new clock.AwakeBudget(budget);
      budgets.set(trial, budgetClock);
      reports.set(trial, report);
      report.trials.push(trial);
      report.revision++;
      const listener = await plugin.addListener('chatDelta', () => {
        trial.nativeDeltas++;
        trial.firstNativeDeltaMs ??= clock.awakeNow() - started;
      });
      try {
        trial.initialProjectIds = (await api('/api/projects')).projects.map((p) => p.id);
        trial.initialGezelIds = (await api('/api/gezels')).gezels.map((g) => g.id);
        if (fixture?.kind === 'meester') {
          trial.projectId = 'default';
          trial.gezelId = (await api('/api/config')).meesterGezelId;
          trial.preexistingArtifacts = [];
          for (const area of ['workspace', 'artifacts']) {
            const listing = await api(`${projectPath('default')}/${area}?recursive=1`);
            for (const file of listing.files.filter((f) => !f.isDirectory)) {
              const result = await api(
                `${projectPath('default')}/${area}/read?path=${encodeURIComponent(file.path)}`,
                'GET',
                undefined,
                true,
              );
              trial.preexistingArtifacts.push({
                projectId: 'default',
                area,
                path: file.path,
                content: result.status === 200 ? result.value.content : null,
              });
            }
          }
        } else {
          const project = await api('/api/projects', 'POST', {
            ...(fixture?.project || { name: `Eval ${id}` }),
            indexingEnabled: false,
          });
          const gezel = await api(
            '/api/gezels',
            'POST',
            fixture?.gezel || { name: 'Eval craftsperson', role: 'Generalist' },
          );
          trial.projectId = project.id;
          trial.gezelId = gezel.id;
          await api(`${projectPath(project.id)}/gezels`, 'POST', { gezelId: gezel.id });
        }
        if (fixture) {
          trial.canonicalFixture = {
            id,
            sourceSha256: fixture.sourceSha256,
            sourceFile: fixture.sourceFile,
            output: fixture.output,
          };
          for (const file of fixture.files) await seed(trial, file.path, file.content);
          for (const prompt of fixture.prompts) await send(trial, prompt);
          await canonicalFeedbackLoop(trial, report);
        } else await cases[id](trial);
        await snapshotTrial(trial, true);
        assertion(trial, 'native-inference-observed', trial.nativeDeltas > 0, {
          deltas: trial.nativeDeltas,
          firstNativeDeltaMs: trial.firstNativeDeltaMs,
        });
        assertion(
          trial,
          'no-provider-error',
          trial.sessions.every(
            (s) =>
              !s.lastTurnError ||
              (id === 'interruption' && /stopped|interrupt/i.test(s.lastTurnError)),
          ),
          trial.sessions.map((s) => ({ id: s.id, error: s.lastTurnError })),
        );
        trial.status = trial.assertions.every((a) => a.passed)
          ? fixture
            ? 'ungraded'
            : 'pass'
          : 'fail';
        if (fixture) report.canonicalCoreCoverage.find((c) => c.id === id).status = trial.status;
      } catch (error) {
        trial.status = 'fail';
        trial.error = error instanceof Error ? error.message : String(error);
        try {
          for (const active of (await api('/api/sessions/inflight')).inflight)
            await api(`/api/sessions/${active.sessionId}/cancel`, 'POST', {});
        } catch (cleanupError) {
          trial.cancellationError = String(cleanupError);
        }
        if (trial.projectId) {
          try {
            await snapshotTrial(trial, true);
          } catch (captureError) {
            trial.evidenceCaptureError = String(captureError);
          }
        }
      } finally {
        await listener.remove();
        trial.finishedAt = now();
        trial.durationMs = clock.awakeNow() - started;
        trial.wallDurationMs = Date.now() - wallStarted;
        trial.suspendedMs = budgetClock.suspendedMs();
        budgets.delete(trial);
        reports.delete(trial);
        report.revision++;
      }
    }
    report.complete = true;
    report.finishedAt = now();
    report.revision++;
    return report;
  }
  async function canonicalFeedbackLoop(trial, report) {
    trial.gradingHistory = [];
    while (!budgets.get(trial).expired()) {
      await idle(trial);
      await snapshotTrial(trial, true);
      if (trial.sessions.some((s) => s.lastTurnError))
        throw new Error('Native provider failed before canonical grading');
      const requestId = `${trial.id}-${crypto.randomUUID()}`;
      globalThis.__gezelMobileEvalGradeReceipt = null;
      trial.gradeRequest = { id: requestId };
      report.revision++;
      const receiptBudget = new clock.AwakeBudget(
        Math.min(300000, budgets.get(trial).remainingMs()),
      );
      while (
        globalThis.__gezelMobileEvalGradeReceipt?.requestId !== requestId &&
        !receiptBudget.expired()
      )
        await pause(200);
      const receipt = globalThis.__gezelMobileEvalGradeReceipt;
      if (receipt?.requestId !== requestId)
        throw new Error('Host canonical grader did not return a matching receipt');
      if (receipt.error) throw new Error(`Host canonical grader failed: ${receipt.error}`);
      trial.gradingHistory.push(receipt);
      delete trial.gradeRequest;
      report.revision++;
      if (receipt.grade.verdict.done) {
        assertion(trial, 'canonical-host-gate', receipt.grade.success, receipt.grade.verdict);
        return;
      }
      for (const feedback of receipt.grade.feedback) {
        const target = trial.gezels.find((g) => g.id === feedback.gezelId);
        if (!target)
          throw new Error('Canonical feedback recipient is outside this native snapshot');
        if (feedback.kind === 'messageGezel')
          await api(
            `/api/gezels/${encodeURIComponent(feedback.gezelId)}/message`,
            'POST',
            feedback.body,
          );
        else if (feedback.kind === 'sendChatMessage') {
          const session = trial.sessions
            .filter(
              (s) =>
                s.gezelId === feedback.gezelId &&
                s.projectId === feedback.body.projectId &&
                !s.archived,
            )
            .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
          if (!session) throw new Error('Canonical chat feedback has no retained native session');
          await api(`/api/sessions/${session.id}/send`, 'POST', feedback.body);
        } else throw new Error('Unknown canonical feedback operation');
        trial.prompts.push({ ...feedback, at: now(), source: 'canonical-host-grader' });
        await idle(trial);
      }
      await pause(5000);
    }
    throw new Error('Canonical trial exhausted its declared awake-time budget');
  }
  function sameJsonValue(left, right) {
    const canonical = (value) => {
      if (Array.isArray(value)) return value.map(canonical);
      if (value !== null && typeof value === 'object')
        return Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        );
      return value;
    };
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
  }
  async function verifyReopen(report) {
    const checks = [];
    for (const trial of [
      ...report.trials,
      ...(report.contracts?.projectId ? [report.contracts] : []),
    ]) {
      for (const file of trial.artifacts || []) {
        if (file.content === null) {
          if (typeof file.bytesBase64 !== 'string') continue;
          const host = window.__GEZEL__;
          const response = await host.fetch(
            new Request(
              `${host.baseUrl}${projectPath(file.projectId)}/${file.area}/read?raw=1&path=${encodeURIComponent(file.path)}`,
              { headers: { Authorization: `Bearer ${host.token}` } },
            ),
          );
          const bytes = new Uint8Array(await response.arrayBuffer());
          let binary = '';
          for (let at = 0; at < bytes.length; at += 8192)
            binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
          checks.push({
            id: `${trial.id}:${file.path}`,
            passed: response.ok && btoa(binary) === file.bytesBase64,
          });
          continue;
        }
        const current = await api(
          `${projectPath(file.projectId)}/${file.area}/read?path=${encodeURIComponent(file.path)}`,
        );
        checks.push({ id: `${trial.id}:${file.path}`, passed: current.content === file.content });
      }
      for (const session of trial.sessions || []) {
        const current = await api(`/api/sessions/${session.id}`);
        checks.push({
          id: `${trial.id}:session:${session.id}`,
          passed: sameJsonValue(current.messages, session.messages),
          ...(sameJsonValue(current.messages, session.messages)
            ? {}
            : {
                expected: JSON.stringify(session.messages),
                actual: JSON.stringify(current.messages),
              }),
        });
      }
      if (trial.task) {
        const current = await api(taskPath(trial.task));
        checks.push({
          id: `${trial.id}:task`,
          passed:
            current.status === trial.task.status &&
            current.activeStepId === trial.task.activeStepId,
        });
      }
      if (trial.taskDraft?.copyId) {
        const base = `${projectPath(trial.projectId)}/prompt-drafts`;
        const saved = await api(`${base}/${trial.taskDraft.id}`);
        const copy = await api(`${base}/${trial.taskDraft.copyId}`);
        checks.push({
          id: 'native-contracts:task-draft',
          passed:
            saved.status === 'sent' &&
            copy.status === 'draft' &&
            saved.taskRef === trial.taskDraft.taskRef &&
            copy.taskRef === saved.taskRef &&
            copy.scope === 'task' &&
            copy.sessionId === null &&
            copy.content === saved.content,
        });
      }
      if (trial.questionId) {
        const questions = await api(
          `/api/questions?project=${encodeURIComponent(trial.projectId)}`,
        );
        checks.push({
          id: 'native-contracts:question-answer',
          passed: questions.questions.some(
            (q) => q.id === trial.questionId && q.answer?.silentSkip,
          ),
        });
      }
    }
    return { at: now(), passed: checks.length > 0 && checks.every((c) => c.passed), checks };
  }
  function mergeReports(reports, complete = false) {
    if (!reports.length) throw new Error('No native phase reports to merge');
    const quality = reports.filter((report) => report.suite !== 'mobile-contracts');
    const first = quality[0] || reports[0];
    const coverage = canonicalCoreCoverage.map((entry) => ({ ...entry }));
    for (const report of reports) {
      for (const entry of report.canonicalCoreCoverage) {
        if (!['not-run', 'unsupported'].includes(entry.status))
          Object.assign(
            coverage.find((item) => item.id === entry.id),
            entry,
          );
      }
    }
    return {
      ...first,
      startedAt: reports[0].startedAt,
      finishedAt: complete ? reports[reports.length - 1].finishedAt : undefined,
      suite: quality.length ? 'mobile-product-v1' : 'mobile-contracts',
      isolation:
        'Fresh native product tree for every quality trial; one retained native model inventory. Each phase is reloaded and verified before the next tree is created.',
      contracts: reports.find((report) => report.contracts)?.contracts,
      trials: quality.flatMap((report) => report.trials),
      canonicalCoreCoverage: coverage,
      complete: complete && reports.every((report) => report.complete),
      reopen: {
        passed: reports.every((report) => report.reopen?.passed),
        checks: reports.flatMap((report) => report.reopen?.checks || []),
      },
    };
  }
  async function verifyFreshProduct() {
    const projects = (await api('/api/projects')).projects;
    const gezels = (await api('/api/gezels')).gezels;
    const sessions = (await api('/api/sessions')).sessions;
    return {
      id: 'native-product-reset-isolated',
      passed:
        !projects.some((project) => project.id === 'contract-workshop') &&
        gezels.length === 1 &&
        gezels[0].role === 'Meester' &&
        sessions.length === 0,
      evidence: {
        projects: projects.map((project) => project.id),
        gezels: gezels.map((gezel) => ({ id: gezel.id, role: gezel.role })),
        sessions: sessions.length,
      },
    };
  }
  globalThis.__gezelMobileEval = {
    run,
    verifyReopen,
    scenarios,
    prepareContracts,
    productMechanicsContracts,
    finishContracts,
    mergeReports,
    verifyFreshProduct,
    snapshotTrial,
    transformedRecordIsCorrect,
    sameJsonValue,
  };
})();
