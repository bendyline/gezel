#!/usr/bin/env node

/**
 * Local engines must not inherit undici's 5-minute fetch timeout.
 *
 * Node's global `fetch` is undici, which defaults `headersTimeout` and
 * `bodyTimeout` to 300s. A local inference engine blows through that in
 * normal operation — a 72k-token prefill on a 27B at 7 tok/s is a
 * quarter of an hour — and undici then throws a bare
 * `TypeError: terminated` that is indistinguishable from the engine
 * dying. Every engine provider already owns its real deadline via an
 * AbortController budget scaled to prompt size; undici's 300s is a
 * second, invisible deadline underneath it, and always the shorter one.
 *
 * This guard exists because the fix was discovered five separate times
 * and copy-pasted into five separate modules, and the sixth engine (MLX)
 * was simply forgotten. Six turns died at ~300s against declared budgets
 * of 595s, 722s and 900s, telling the user the engine had crashed and to
 * retry — advice that could not work, since the same prompt hits the same
 * wall every time.
 *
 * Two rules:
 *
 *   1. ONE OWNER. Only `patient-fetch.ts` may construct the zero-timeout
 *      undici Agent. A seventh copy is how this drifts back apart.
 *
 *   2. EVERY ENGINE BUILDER INJECTS. Provider classes deliberately
 *      keep `opts.fetchImpl ?? fetch` — that fallback is the seam the
 *      provider suites inject a stub through, and moving the default
 *      would break every test that stubs `globalThis.fetch`. So the
 *      obligation sits one level up, on the module that CONSTRUCTS the
 *      provider: a `*factory.ts` or `build-provider.ts` under
 *      `providers/` must pass `patientFetch()`, or say in a file-level
 *      `// patient-fetch-exempt: <reason>` why the 300s cap is right.
 *      Remote web APIs, downloads and readiness probes are legitimately
 *      exempt — they SHOULD time out. The point is that inheriting the
 *      global default becomes a decision someone wrote down, instead of
 *      what you get by not thinking about it. This is exactly the rule
 *      MLX violated: six sibling builders injected, its own never did.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CANONICAL = 'packages/service/src/providers/patient-fetch.ts';
const PROVIDERS_ROOT = 'packages/service/src/providers';

/**
 * Modules allowed to build their own zero-timeout dispatcher because
 * they need a different Agent entirely, not because they are engines.
 */
const AGENT_ALLOWLIST = new Map([
  [
    'packages/service/src/remotes/pinned-fetch.ts',
    'pins a self-signed LAN cert; needs its own Agent with a custom TLS verifier',
  ],
]);

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (/\.[cm]?ts$/.test(entry.name) && !/\.(?:test|spec)\.[cm]?ts$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

const rel = (p) => relative(root, p).replaceAll('\\', '/');
const failures = [];

// Rule 1 — one owner for the zero-timeout dispatcher.
for (const file of await walk(resolve(root, 'packages/service/src'))) {
  const path = rel(file);
  if (path === CANONICAL || AGENT_ALLOWLIST.has(path)) continue;
  const source = await readFile(file, 'utf8');
  if (/new Agent\(\s*\{[^}]*(?:headersTimeout|bodyTimeout)\s*:\s*0/s.test(source)) {
    failures.push(
      `${path}: builds its own zero-timeout undici Agent.\n` +
        `    Import \`patientFetch\` from ${CANONICAL} instead — one owner, so the next\n` +
        `    engine cannot be given a copy that drifts.`,
    );
  }
}

// Rule 2 — every engine builder injects a patient fetch.
for (const file of await walk(resolve(root, PROVIDERS_ROOT))) {
  const path = rel(file);
  if (!/(?:^|\/)(?:[a-z-]*factory|build-provider)\.ts$/.test(path)) continue;
  const source = await readFile(file, 'utf8');
  if (source.includes('patientFetch(')) continue;
  if (/\/\/\s*patient-fetch-exempt:\s*\S/.test(source)) continue;
  failures.push(
    `${path}: builds a provider without passing \`fetchImpl: patientFetch()\`, so it\n` +
      `    inherits Node's global fetch and undici's 300s cap.\n` +
      `    If it drives a local engine, pass \`fetchImpl: patientFetch()\`.\n` +
      `    If the 300s cap is correct (a remote API, a download), say so at the top\n` +
      `    of the file: // patient-fetch-exempt: <reason>`,
  );
}

if (failures.length > 0) {
  console.error('Patient-fetch guard failed:\n');
  for (const failure of failures) console.error(`  - ${failure}\n`);
  process.exit(1);
}

console.log('Patient-fetch guard passed.');
