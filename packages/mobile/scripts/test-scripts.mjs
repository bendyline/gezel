import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../ui/package.json', import.meta.url));
const { chromium } = require('playwright');
const { createServer } = await import(require.resolve('vite'));
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({
  root,
  configFile: `${root}/vite.config.ts`,
  optimizeDeps: { noDiscovery: true, entries: [] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'portable-script-test',
      configureServer(server) {
        server.middlewares.use('/__script_test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><title>Portable script test</title>');
        });
      },
    },
  ],
});
let browser;
let page;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  const external = [];
  page.on('request', (request) => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:'))
      external.push(request.url());
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__script_test`);
  const result = await page.evaluate(
    async ({ coreRuntimeUrl, clientUrl }) => {
      const { createMobileScripts, MobileQuickJSExecutor } = await import('/src/scripts.ts');
      const { createBrowserProductFiles, browserDatabase } = await import('/src/browser-files.ts');
      const { PortableStore, PortableProductService } = await import(coreRuntimeUrl);
      const { GezelClient } = await import(clientUrl);
      const database = `gezel-script-test-${crypto.randomUUID()}`;
      const files = createBrowserProductFiles(browserDatabase(database));
      const store = new PortableStore({
        files,
      });
      await store.ensureLayout();
      const scripts = createMobileScripts(store);
      await scripts.initialize();
      const check = (value, label) => {
        if (!value) throw new Error(label);
      };
      const manual = { kind: 'manual', userInitiated: true };
      const run = (scriptName, inputs) =>
        scripts.run({
          projectId: 'default',
          scriptName,
          scope: 'standard',
          inputs,
          trigger: manual,
        });
      const created = await run('storeRecords', {
        action: 'create',
        id: 'first',
        fields: { title: 'Offline note' },
        root: 'notes',
        mode: 'single-file',
      });
      check(created.status === 'ok', `record creation failed: ${created.error}`);
      const record = JSON.parse(await store.readFile('workspace', 'default', 'notes.json'));
      check(record.records.first.title === 'Offline note', 'workspace effect lost');
      check((await store.getScriptRun('default', created.id)).status === 'ok', 'run audit missing');
      check(
        (await run('checkJsonValid', { file: 'notes.json' })).output.decision === 'approve',
        'shared gate failed',
      );
      await store.updateProject('default', { managedWorkspaceWritePolicy: 'deny' });
      const denied = await run('storeRecords', {
        action: 'create',
        id: 'second',
        fields: { title: 'Denied' },
        root: 'notes',
        mode: 'single-file',
      });
      check(
        denied.status === 'error' && /denied|turned off/.test(denied.error),
        'workspace policy bypassed',
      );
      check(
        !JSON.parse(await store.readFile('workspace', 'default', 'notes.json')).records.second,
        'denied write ran',
      );
      await store.writeFile(
        'artifacts',
        'default',
        'corpus/attachments/pr-files.json',
        JSON.stringify({
          totalFiles: 1,
          batches: [{ batchNumber: 1, start: 1, end: 1, paths: ['source.ts'] }],
          files: [{ ordinal: 1, path: 'source.ts', recordHash: '12345678' }],
        }),
      );
      await store.writeFile(
        'artifacts',
        'default',
        'corpus/files/_flags.json',
        JSON.stringify({ 12345678: { file: '001--source--12345678.md' } }),
      );
      const transformed = await run('publishCorpusBatches', {
        corpusDir: 'corpus',
        outFile: 'review/batches.json',
      });
      check(transformed.status === 'ok', `artifact transformation failed: ${transformed.error}`);
      check(
        JSON.parse(await store.readFile('artifacts', 'default', 'review/batches.json'))[0].records
          .length === 1,
        'transformed artifact missing',
      );
      const executor = new MobileQuickJSExecutor();
      let output;
      const options = (source, timeoutMs = 5_000) => ({
        source,
        scriptName: 'test',
        timeoutMs,
        init: {
          projectId: 'default',
          runId: crypto.randomUUID(),
          input: {},
          engagementMode: 'off',
          engagementFlags: { llmAllowed: false },
        },
        provenanceTrusted: false,
        trustedReadOnlyStandard: false,
        onRequest: async () => {
          throw new Error('Unexpected host request');
        },
        onNotification: (_method, params) => {
          output = params.value;
        },
        onStdout() {},
        onStderr() {},
      });
      check(
        (
          await executor.execute(
            options(
              "import {gezel} from '@bendyline/gezel-sdk'; gezel.output([typeof fetch,typeof process,typeof require,typeof Worker,typeof __gezelCall]);",
            ),
          )
        ).exitCode === 0,
        'guest environment probe failed',
      );
      check(
        output.every((value) => value === 'undefined'),
        'guest received platform globals',
      );
      for (const source of [
        "await import('node:fs')",
        "await import('https://example.invalid/exfiltrate.js')",
      ]) {
        check(
          (await executor.execute(options(source))).exitCode !== 0,
          'unbundled module accepted',
        );
      }
      let ticks = 0;
      const ticker = setInterval(() => ticks++, 10);
      const loop = await executor.execute(options('while (true) {}', 150));
      clearInterval(ticker);
      check(loop.timedOut && ticks > 0, 'guest loop blocked UI or escaped deadline');
      const controller = new AbortController();
      const slow = executor.execute({
        ...options('await new Promise(() => {})'),
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 80);
      check((await slow).stderr.includes('cancelled'), 'worker cancellation failed');
      const interrupted = {
        ...created,
        id: crypto.randomUUID(),
        status: 'running',
        finishedAt: undefined,
      };
      await store.writeScriptRun(interrupted);
      await scripts.initialize();
      const recovered = await store.getScriptRun('default', interrupted.id);
      check(
        recovered.status === 'error' && recovered.error.includes('not replayed'),
        'interrupted script was not recovered',
      );
      const service = new PortableProductService(
        store,
        {
          providers: async () => [],
          generate: async () => {
            throw new Error('Unexpected inference');
          },
          cancel: async () => {},
        },
        'test-token',
      );
      service.setScripts(scripts);
      await service.initialize();
      const client = new GezelClient({
        baseUrl: 'https://gezel.local',
        token: 'test-token',
        fetch: service.fetch,
      });
      const authoredSource = `import { defineScript, gezel } from '@bendyline/gezel-sdk';
export const meta = defineScript({name:'saveLocal',description:'Write a local verification artifact',requires:['artifacts.write'],outputs:{ok:{type:'boolean',description:'Saved'}}} as const);
const message: string = 'offline compiler and QuickJS';
await gezel.artifacts.write('authored.txt',message); gezel.output({ok:true});`;
      const draft = await client.createProjectScript('default', {
        name: 'saveLocal',
        source: authoredSource,
      });
      const saved = await client.saveProjectScriptSource('default', {
        name: 'saveLocal',
        source: authoredSource,
        baseHash: draft.hash,
      });
      check(
        saved.status === 'saved' && saved.metaOk && saved.diagnostics.length === 0,
        'authored source diagnostics failed',
      );
      const authored = await client.runProjectScript('default', { name: 'saveLocal' });
      check(authored.status === 'ok', `authored script failed: ${authored.error}`);
      check(
        (await store.readFile('artifacts', 'default', 'authored.txt')) ===
          'offline compiler and QuickJS',
        'authored artifact missing',
      );
      check(
        (await client.getSdkTypes()).files.some((file) => file.name.includes('gezel-sdk')),
        'shared editor SDK types missing',
      );
      const conflicted = await client.saveProjectScriptSource('default', {
        name: 'saveLocal',
        source: 'lost?',
        baseHash: 'stale',
      });
      check(
        conflicted.status === 'conflict' && conflicted.currentSource === authoredSource,
        'conflict overwrote source',
      );
      const invalidSource = `${authoredSource}\nimport fs from 'node:fs';`;
      const invalid = await client.saveProjectScriptSource('default', {
        name: 'saveLocal',
        source: invalidSource,
        baseHash: draft.hash,
      });
      check(
        invalid.status === 'saved' && invalid.diagnostics.some((item) => item.severity === 'error'),
        'native import accepted',
      );
      check(
        (await client.getProjectScriptSource('default', 'saveLocal')).source === invalidSource,
        'invalid edits were lost',
      );
      let blocked = false;
      try {
        await client.runProjectScript('default', { name: 'saveLocal' });
      } catch {
        blocked = true;
      }
      check(blocked, 'invalid authored source executed');
      await client.createUserScript({
        name: 'saveLocal',
        source: authoredSource.replace('offline compiler and QuickJS', 'user library'),
      });
      check(
        (await client.runProjectScript('default', { name: 'saveLocal', scope: 'user' })).status ===
          'ok',
        'user scope did not resolve explicitly',
      );
      const reopened = new PortableStore({
        files: createBrowserProductFiles(browserDatabase(database)),
      });
      check(
        (await reopened.readScriptSource({ scope: 'project', projectId: 'default' }, 'saveLocal'))
          .source === invalidSource,
        'source was not durable across store restart',
      );
      const scaffold = await client.createProjectScript('default', {
        name: 'blankLocal',
        template: 'blank',
      });
      check(scaffold.source.includes('defineScript'), 'shared scaffold unavailable');
      await client.createProjectScript('default', {
        name: 'prepareLocal',
        source: `import {defineScript, gezel} from '@bendyline/gezel-sdk';
export const meta = defineScript({name:'prepareLocal',description:'Prepare a useful artifact and task note',requires:['artifacts.write','tasks.write'],inputs:{taskRef:{type:'string',description:'Current task',required:true}},outputs:{ok:{type:'boolean',description:'Prepared'}}} as const);
await gezel.artifacts.write('hook.txt','Prepared by an authored TypeScript hook');
await gezel.task.writeNotes(gezel.input.taskRef,'Prepared by the offline script'); gezel.output({ok:true});`,
      });
      await client.createUserScript({
        name: 'approveLocal',
        source: `import {defineScript, gezel} from '@bendyline/gezel-sdk';
export const meta = defineScript({name:'approveLocal',description:'Inspect the artifact and note before approving',kind:'gate',requires:['artifacts.read','tasks.read'],inputs:{taskRef:{type:'string',description:'Current task',required:true}},outputs:{decision:{type:'string',description:'Gate decision'},message:{type:'string',description:'Explanation'}}} as const);
const content = await gezel.artifacts.read('hook.txt'); const notes = await gezel.task.readNotes(gezel.input.taskRef);
gezel.output({decision:content.includes('authored') && notes.includes('offline') ? 'approve' : 'reject',message:'Artifact and note checked'});`,
      });
      await store.writeConfig({
        securityPolicy: {
          level: 'lockdown',
          allowFileEdits: true,
          allowExternalChat: true,
          allowExternalServices: false,
          allowScriptExecution: true,
          allowAppNetwork: true,
        },
      });
      const lead = await client.createGezel({ name: 'Offline writer', role: 'Generalist' });
      const task = await client.createTask('default', {
        title: 'Authored offline workflow',
        description: 'Prepare, check, and archive a useful report entirely offline.',
        assignee: { kind: 'gezel', gezelId: lead.id },
        steps: [
          {
            name: 'Prepare',
            onEnter: { name: 'prepareLocal', autoAdvanceOnSuccess: true },
            onExit: { name: 'saveLocal', scope: 'user' },
            gate: { at: 'completion', scripts: [{ name: 'approveLocal', scope: 'user' }] },
          },
          {
            name: 'Archive',
            terminal: true,
            onEnter: { name: 'prepareLocal', autoAdvanceOnSuccess: true },
          },
        ],
      });
      await client.retryTask('default', task.num);
      for (let i = 0; service.busy && i < 1000; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      const finishedTask = await client.getTask('default', task.num);
      if (service.busy || finishedTask.status !== 'complete') {
        const records = {};
        const capture = async (path) => {
          for (const entry of await files.list(path)) {
            const child = `${path}/${entry.name}`;
            if (entry.isDirectory) await capture(child);
            else if (entry.name.endsWith('.json')) {
              const bytes = await files.read(child);
              if (bytes) records[child] = JSON.parse(new TextDecoder().decode(bytes));
            }
          }
        };
        await capture(`projects/default/tasks/${task.num}`);
        await capture('projects/default/scripts/runs');
        globalThis.__scriptFailure = {
          reason: 'authored lifecycle workflow did not finish',
          busy: service.busy,
          task: finishedTask,
          lifecycle: await store.getTaskLifecycle(task.ref),
          records,
        };
      }
      check(
        !service.busy && finishedTask.status === 'complete',
        'authored lifecycle workflow did not finish',
      );
      check(
        (await client.listTaskNotes('default', task.num)).notes.length === 2,
        'SDK notes did not follow both activations',
      );
      const locked = await client.createTask('default', {
        title: 'Policy refusal',
        description: 'Hold this workflow when authored script execution is disabled.',
        assignee: { kind: 'gezel', gezelId: lead.id },
        steps: [
          {
            name: 'Start',
            terminal: true,
            onEnter: { name: 'prepareLocal', autoAdvanceOnSuccess: true },
          },
        ],
      });
      await store.deleteFile('artifacts', 'default', 'hook.txt');
      await store.writeConfig({
        securityPolicy: {
          level: 'super-lockdown',
          allowFileEdits: false,
          allowExternalChat: false,
          allowExternalServices: false,
          allowScriptExecution: false,
          allowAppNetwork: false,
        },
      });
      await client.retryTask('default', locked.num);
      for (let i = 0; service.busy && i < 1000; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      check(
        (await client.getTask('default', locked.num)).status === 'paused',
        'script policy did not hold the task',
      );
      check(
        (await store.readFile('artifacts', 'default', 'hook.txt')) === null,
        'refused hook wrote its artifact',
      );
      check(
        (await client.listTaskNotes('default', locked.num)).notes.length === 0,
        'refused hook wrote task notes',
      );
      await store.writeConfig({
        securityPolicy: {
          level: 'lockdown',
          allowFileEdits: true,
          allowExternalChat: true,
          allowExternalServices: false,
          allowScriptExecution: true,
          allowAppNetwork: true,
        },
      });
      const embeddedSource = (
        await client.getProjectScriptSource('default', 'prepareLocal')
      ).source.replaceAll('prepareLocal', 'embeddedPrepare');
      const embeddedBook = {
        id: 'embedded-offline-contract',
        name: 'Embedded offline contract',
        version: '1.2.3',
        scripts: { embeddedPrepare: embeddedSource },
        steps: [
          {
            id: 'prepare',
            name: 'Prepare',
            terminal: true,
            onEnter: { name: 'embeddedPrepare', scope: 'craftbook', autoAdvanceOnSuccess: true },
            gate: {
              at: 'completion',
              scripts: [
                {
                  name: 'checkTaskNoteContains',
                  scope: 'standard',
                  inputs: { pattern: 'offline script' },
                },
              ],
            },
          },
        ],
        entryStepId: 'prepare',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const embedded = await store.createTask(
        'default',
        {
          title: 'Embedded script snapshot',
          description:
            'Run exactly the embedded recipe source, regardless of project library edits.',
          craftbookId: embeddedBook.id,
          assignee: { kind: 'gezel', gezelId: lead.id },
        },
        embeddedBook,
      );
      const installed = await client.getProjectScriptSource('default', 'embeddedPrepare');
      check(
        installed.provenance?.ref === 'embedded-offline-contract@1.2.3',
        'embedded install lost template identity',
      );
      await client.saveProjectScriptSource('default', {
        name: 'embeddedPrepare',
        source: 'throw new Error("wrong installed copy");',
      });
      const observed = [];
      const previousRun = scripts.run;
      scripts.run = async (options) => {
        const result = await previousRun(options);
        observed.push(result);
        return result;
      };
      await client.retryTask('default', embedded.num);
      for (let i = 0; service.busy && i < 1000; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      check(
        (await client.getTask('default', embedded.num)).status === 'complete',
        'embedded snapshot was shadowed by an edited installed copy',
      );
      const embeddedRun = observed.find((run) => run.scriptName === 'embeddedPrepare');
      const digest = Array.from(
        new Uint8Array(
          await crypto.subtle.digest('SHA-256', new TextEncoder().encode(embeddedSource)),
        ),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('');
      const audited = await store.getScriptRun('default', embeddedRun.id);
      check(
        audited.scope === 'craftbook' &&
          audited.sourceHash === digest &&
          audited.sourceCraftbook.id === embeddedBook.id &&
          audited.sourceCraftbook.version === '1.2.3',
        'embedded execution audit lost its exact source identity',
      );
      scripts.run = previousRun;
      const childSource = `import {defineScript,gezel} from '@bendyline/gezel-sdk';
export const meta=defineScript({name:'nestedChild',description:'A nested offline child',requires:['artifacts.write'],inputs:{message:{type:'string',description:'Body',required:true}}} as const);
await gezel.artifacts.write('nested-child.md',String(gezel.input.message)); gezel.output({saved:true});`;
      const parentSource = `import {defineScript,gezel} from '@bendyline/gezel-sdk';
export const meta=defineScript({name:'nestedParent',description:'Call a project script through the shared SDK'} as const);
const result=await gezel.script.run('nestedChild',{message:'Nested worker saved this'});
if(result.status!=='ok')throw new Error(result.error); gezel.output(result);`;
      await client.createProjectScript('default', { name: 'nestedChild', source: childSource });
      await client.createUserScript({
        name: 'nestedChild',
        source: childSource.replace(
          'await gezel.artifacts.write',
          "throw new Error('Wrong scope'); await gezel.artifacts.write",
        ),
      });
      await client.createUserScript({ name: 'nestedParent', source: parentSource });
      const nested = await client.runProjectScript('default', {
        name: 'nestedParent',
        scope: 'user',
      });
      check(nested.status === 'ok', `nested QuickJS failed: ${nested.error}`);
      const nestedAudit = await client.getProjectScriptRun('default', nested.output.runId);
      check(
        nestedAudit.scope === 'project' &&
          nestedAudit.trigger.kind === 'nested' &&
          nestedAudit.trigger.parentRunId === nested.runId,
        'nested scope or lineage lost',
      );
      check(
        (await store.readFile('artifacts', 'default', 'nested-child.md')) ===
          'Nested worker saved this',
        'nested artifact missing',
      );
      check(
        (await client.getProjectScriptRun('default', nested.runId)).calls[0].kind === 'script.run',
        'nested parent audit missing',
      );

      const recursiveSource = `${childSource.slice(0, childSource.indexOf('await gezel.artifacts.write'))}const child=await gezel.script.run('nestedChild',{message:'recurse'}); if(child.status!=='ok')throw new Error(child.error);`;
      await client.saveProjectScriptSource('default', {
        name: 'nestedChild',
        source: recursiveSource,
      });
      const recursion = await client.runProjectScript('default', {
        name: 'nestedParent',
        scope: 'user',
      });
      check(
        recursion.status === 'error' && recursion.error.includes('nested script depth exceeded'),
        'nested recursion escaped its limit',
      );

      const policySource = childSource.replace(
        "await gezel.artifacts.write('nested-child.md',String(gezel.input.message));",
        "await gezel.artifacts.write('nested-policy-start.md','Started'); await gezel.artifacts.write('nested-policy-denied.md','Denied');",
      );
      await client.saveProjectScriptSource('default', {
        name: 'nestedChild',
        source: policySource,
      });
      const writeFile = store.writeFile.bind(store);
      store.writeFile = async (...args) => {
        const value = await writeFile(...args);
        if (args[2] === 'nested-policy-start.md')
          await store.writeConfig({
            securityPolicy: {
              level: 'super-lockdown',
              allowFileEdits: false,
              allowExternalChat: false,
              allowExternalServices: false,
              allowScriptExecution: false,
              allowAppNetwork: false,
            },
          });
        return value;
      };
      try {
        const policySession = await store.createSession({
          gezelId: lead.id,
          projectId: 'default',
          providerName: 'llama-cpp',
        });
        const policyRun = await scripts.run({
          projectId: 'default',
          scriptName: 'nestedParent',
          scope: 'user',
          trigger: { kind: 'chat', gezelId: lead.id, sessionId: policySession.id },
        });
        check(
          policyRun.status === 'error' && policyRun.error.includes('script execution is disabled'),
          `nested child lost parent live policy: ${policyRun.error ?? policyRun.status}`,
        );
        check(
          (await store.readFile('artifacts', 'default', 'nested-policy-denied.md')) === null,
          'revoked child performed an effect',
        );
      } finally {
        store.writeFile = writeFile;
        await store.writeConfig({
          securityPolicy: {
            level: 'lockdown',
            allowFileEdits: true,
            allowExternalChat: true,
            allowExternalServices: false,
            allowScriptExecution: true,
            allowAppNetwork: true,
          },
        });
      }
      const slowSource = childSource.replace(
        "await gezel.artifacts.write('nested-child.md',String(gezel.input.message)); gezel.output({saved:true});",
        "await gezel.artifacts.write('nested-cancel-start.md','Started'); while(true){}",
      );
      await client.saveProjectScriptSource('default', { name: 'nestedChild', source: slowSource });
      const cancelAudits = [];
      const persistRun = store.writeScriptRun.bind(store);
      store.writeScriptRun = async (run) => {
        await persistRun(run);
        if (run.scriptName === 'nestedChild' && run.status !== 'running') cancelAudits.push(run);
      };
      try {
        const runningNested = client.runProjectScript('default', {
          name: 'nestedParent',
          scope: 'user',
        });
        for (
          let i = 0;
          i < 500 &&
          (await store.readFile('artifacts', 'default', 'nested-cancel-start.md')) === null;
          i++
        )
          await new Promise((resolve) => setTimeout(resolve, 10));
        check(
          (await store.readFile('artifacts', 'default', 'nested-cancel-start.md')) !== null,
          'nested cancellation child did not start',
        );
        await scripts.cancel();
        const cancelledNested = await runningNested;
        check(
          cancelledNested.status === 'error' && !scripts.isBusy(),
          'nested cancellation did not release admission',
        );
        check(
          cancelAudits.length === 1 &&
            cancelAudits[0].status === 'error' &&
            cancelAudits[0].trigger.parentRunId === cancelledNested.runId,
          'child cancellation audit was lost',
        );
        check(
          (await client.getProjectScriptRun('default', cancelAudits[0].id)).status === 'error',
          'cancelled child audit not persisted',
        );
      } finally {
        store.writeScriptRun = persistRun;
      }
      const { testScriptTasks } = await import('/scripts/test-script-tasks.browser.js');
      const taskChecks = await testScriptTasks({
        client,
        store,
        scripts,
        service,
        files,
        check,
        leadId: lead.id,
      });
      return {
        tests: 29 + taskChecks,
        script: transformed.scriptName,
        output: transformed.output,
        uiTicks: ticks,
      };
    },
    {
      coreRuntimeUrl: `/@fs${fileURLToPath(new URL('../../core/dist/runtime/index.js', import.meta.url))}`,
      clientUrl: `/@fs${fileURLToPath(new URL('../../client/dist/index.js', import.meta.url))}`,
    },
  );
  assert.deepEqual(external, [], 'script workflow made external requests');
  console.log(JSON.stringify(result));
} catch (error) {
  const diagnostics = await page?.evaluate(() => globalThis.__scriptFailure).catch(() => null);
  if (diagnostics) {
    const path = join(tmpdir(), `gezel-mobile-scripts-failure-${Date.now()}.json`);
    await writeFile(path, JSON.stringify(diagnostics, null, 2));
    console.error(`Script failure diagnostics: ${path}`);
  }
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
