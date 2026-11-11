// Runs Gezel scripts copied from package READMEs the way the README tells a host
// to: the built service's ScriptRunner with the QuickJS executor, in a fresh
// home. QuickJS needs no operating-system sandbox, so this behaves the same on
// every CI platform. readmeExamples.test.ts spawns it and reads one JSON line.
//
// Usage: node readme-script-harness.mjs <repoRoot> <home> <scripts.json>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [repoRoot, home, scriptsFile] = process.argv.slice(2);
const dist = (pkg, file) => pathToFileURL(join(repoRoot, 'packages', pkg, 'dist', file)).href;

const { QuickJSWorkerExecutor, ScriptRunner, Store } = await import(dist('service', 'index.js'));
const { computeScriptDiagnostics } = await import(dist('script-runtime', 'source.js'));
const { parseScriptMeta } = await import(dist('script-runtime', 'meta.js'));

const store = new Store({ home });
await store.ensureLayout();
const runner = new ScriptRunner({ store, executor: new QuickJSWorkerExecutor() });

const results = [];
for (const { label, source } of JSON.parse(readFileSync(scriptsFile, 'utf8'))) {
  const errors = computeScriptDiagnostics(source, `${label}.ts`)
    .filter((d) => d.severity === 'error')
    .map((d) => `${d.source}: ${d.message}`);
  let run = null;
  if (errors.length === 0) {
    try {
      const record = await runner.run({
        projectId: 'default',
        scriptName: parseScriptMeta(source, `${label}.ts`).name,
        inlineSource: source,
        trigger: { kind: 'manual', userInitiated: true },
        timeoutMs: 60_000,
      });
      run = { status: record.status, output: record.output ?? null, error: record.error ?? null };
    } catch (err) {
      run = { status: 'threw', output: null, error: String(err?.message ?? err) };
    }
  }
  results.push({ label, errors, run });
}

process.stdout.write(`${JSON.stringify(results)}\n`);
// QuickJS workers would otherwise keep the process alive after the last run.
process.exit(0);
