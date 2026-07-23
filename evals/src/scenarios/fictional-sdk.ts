import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { postMissingDeliverableFeedback, postSniffFeedback } from '../sniff-feedback.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import { materializeProjectWorkspace, spawnAndAwait } from './helpers.ts';
import { TRUSTED_RUNNER_KICKOFF, trustedCheckRunnerEnabled } from './trusted-check-runner.ts';

/**
 * Fictional-sdk — implement against docs for an API that cannot be
 * memorized (scenario #5 in docs/orthogonal-scenarios-2026-06.md).
 *
 * Every current coding scenario can be solved from pretraining; small
 * models substitute memorized idioms for what the docs actually say.
 * "Quill" is a made-up message-queue SDK whose semantics deliberately
 * cut against the common queue-library idioms:
 *   - commit() takes the ackToken minted by take(), NOT the message id
 *     (the ack(msg) muscle-memory trap),
 *   - release() takes the message id, NOT the ackToken (the inverse),
 *   - released messages are NOT redelivered,
 *   - every taken message must be resolved before the next take(),
 *   - close() is mandatory and throws while takes are unresolved.
 *
 * The seeded stub (lib/quill.mjs) implements exactly what
 * docs/quill-sdk.md says and throws loud, instructive errors on
 * memorized-idiom misuse. The model writes worker.mjs; the seeded
 * read-only driver (run.mjs) executes it against the stub and audits
 * per-message outcomes via internal state — a pure runtime gate, no
 * style regexes. Failures surface as verbatim `CASE n:` lines.
 */

const PROJECT_NAME = 'Quill Queue Worker';
const DEVELOPER_NAME = 'Pia';

export const DOCS_PATH = 'docs/quill-sdk.md';
export const LIB_PATH = 'lib/quill.mjs';
export const RUN_PATH = 'run.mjs';
export const WORKER_PATH = 'worker.mjs';

/** 22 seeded messages; the 5 whose body matches /spam/i must be released. */
export const SPAM_COUNT = 5;
export const NON_SPAM_COUNT = 17;

// ─────────────────────────────────────────────────────────────────────
// Seed fixtures. The .mjs sources avoid template literals so they can
// live inside these TS template strings unescaped.

export const QUILL_DOCS_MD = `# Quill SDK v0.4 — client reference

Quill is a lightweight message-queue SDK. This document is the COMPLETE
contract for the in-memory client in \`lib/quill.mjs\`. Quill is not
Kafka, RabbitMQ, SQS, or amqplib — method names and argument types
follow this document, not conventions from other queue libraries.

## connect(url)

Returns a connected client. \`url\` must be a string starting with
\`quill://\` (for this project use \`connect('quill://local')\`). Throws
on anything else.

## client.take(n)

Takes up to \`n\` messages from the front of the queue. \`n\` must be a
positive integer.

- Returns an array of message objects: \`{ id, body, ackToken }\`.
  - \`id\` — the queue's stable message id (a string like \`m-07\`).
  - \`body\` — the message payload (a string).
  - \`ackToken\` — a single-use token minted for THIS take. Tokens look
    like \`qtok-...\` and cannot be derived from the id.
- When fewer than \`n\` messages are pending, returns however many
  remain. When the queue is empty, returns \`[]\`.
- Every message returned by take() MUST be resolved — either
  \`client.commit(message.ackToken)\` or \`client.release(message.id)\`
  — before the next call to take(). take() throws if any message from
  the previous batch is still unresolved.

## client.commit(ackToken)

Permanently accepts a message. \`commit\` takes the **ackToken** minted
by take() — NOT the message id. Passing a message id throws. Each
ackToken is single-use: committing it twice throws.

## client.release(id)

Discards a message without committing it. \`release\` takes the
**message id** — NOT the ackToken. Passing an ackToken throws. Released
messages are removed for good; Quill does NOT redeliver them. Only
messages from the current (unresolved) take batch can be released.

## client.stats()

Returns \`{ pending, committed, released }\`. \`pending\` counts every
message not yet committed or released (still queued, or taken but
unresolved). stats() may be called at any time, including after
close().

## client.close()

Must be called exactly once when the worker is done. Throws if any
taken message is still unresolved. After close(), take/commit/release
throw. The read-only property \`client.closed\` reports whether close()
has been called.
`;

export const QUILL_LIB_MJS = `// Quill SDK v0.4 — in-memory reference implementation. READ-ONLY seed:
// the scenario checker compares this file byte-for-byte against the
// original. The public contract lives in docs/quill-sdk.md.

const SEED_MESSAGES = [
  { id: 'm-01', body: 'order #1042 shipped to warehouse B' },
  { id: 'm-02', body: 'invoice 88 due 2026-07-01' },
  { id: 'm-03', body: 'SPAM: you have won a free cruise — claim now' },
  { id: 'm-04', body: 'password reset requested for acct 7731' },
  { id: 'm-05', body: 'build #5520 passed on main' },
  { id: 'm-06', body: 'new signup: orla@example.com' },
  { id: 'm-07', body: 'Hot crypto spam — double your coins overnight' },
  { id: 'm-08', body: 'ticket QA-201 moved to in-review' },
  { id: 'm-09', body: 'payment of $129.00 received for order #1042' },
  { id: 'm-10', body: 'backup completed: 412 GB in 38 min' },
  { id: 'm-11', body: 'meeting moved to 14:30 in room Jade' },
  { id: 'm-12', body: 'Spam alert: extend your car warranty today' },
  { id: 'm-13', body: 'cert for api.example.com renews in 30 days' },
  { id: 'm-14', body: 'order #1043 delayed: carrier weather hold' },
  { id: 'm-15', body: 'weekly digest: 7 new comments, 2 mentions' },
  { id: 'm-16', body: '[sPaM] cheap meds no prescription needed' },
  { id: 'm-17', body: 'disk usage on db-2 at 81 percent' },
  { id: 'm-18', body: 'refund issued for order #0998' },
  { id: 'm-19', body: 'new device login from 10.1.4.22' },
  { id: 'm-20', body: 'quarterly report draft ready for review' },
  { id: 'm-21', body: 'This is definitely not SPAM (it is) — free gift cards' },
  { id: 'm-22', body: 'release 2.9.1 tagged and published' },
];

let tokenCounter = 0;
function mintToken(id) {
  tokenCounter += 1;
  const seedStr = id + ':' + tokenCounter + ':quill';
  let h = 0x811c9dc5;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 'qtok-' + (h >>> 0).toString(36) + '-' + tokenCounter;
}

class QuillClient {
  #pending;
  #allIds;
  #outstandingByToken = new Map(); // ackToken -> id
  #outstandingIds = new Set();
  #status = new Map(); // id -> 'pending' | 'taken' | 'committed' | 'released'
  #takeSizes = [];
  #closed = false;

  constructor(messages) {
    this.#pending = messages.map((m) => ({ id: m.id, body: m.body }));
    this.#allIds = new Set(messages.map((m) => m.id));
    for (const m of messages) this.#status.set(m.id, 'pending');
  }

  get closed() {
    return this.#closed;
  }

  #assertOpen(method) {
    if (this.#closed) {
      throw new Error(method + '() called after close() — the client is closed.');
    }
  }

  take(n) {
    this.#assertOpen('take');
    if (!Number.isInteger(n) || n < 1) {
      throw new Error('take(n) expects a positive integer batch size, got ' + JSON.stringify(n) + '.');
    }
    if (this.#outstandingByToken.size > 0) {
      throw new Error(
        'take() called while ' +
          this.#outstandingByToken.size +
          ' message(s) from the previous take are unresolved — commit(message.ackToken) or ' +
          'release(message.id) every taken message before taking more. See docs/quill-sdk.md.',
      );
    }
    this.#takeSizes.push(n);
    const batch = this.#pending.splice(0, n);
    return batch.map((m) => {
      const ackToken = mintToken(m.id);
      this.#outstandingByToken.set(ackToken, m.id);
      this.#outstandingIds.add(m.id);
      this.#status.set(m.id, 'taken');
      return { id: m.id, body: m.body, ackToken };
    });
  }

  commit(ackToken) {
    this.#assertOpen('commit');
    if (this.#allIds.has(ackToken)) {
      throw new Error(
        'commit() expects the ackToken from take(), not the message id — pass the .ackToken ' +
          'field of the message object you received from take() (got the id "' +
          ackToken +
          '"). See docs/quill-sdk.md.',
      );
    }
    const id = this.#outstandingByToken.get(ackToken);
    if (id === undefined) {
      throw new Error(
        'commit(): unknown or already-used ackToken ' +
          JSON.stringify(ackToken) +
          ' — ackTokens are minted by take() and are single-use.',
      );
    }
    this.#outstandingByToken.delete(ackToken);
    this.#outstandingIds.delete(id);
    this.#status.set(id, 'committed');
  }

  release(id) {
    this.#assertOpen('release');
    if (typeof id === 'string' && id.startsWith('qtok-')) {
      throw new Error(
        'release() expects the message id, not the ackToken — pass the .id field of the ' +
          'message object you received from take(). See docs/quill-sdk.md.',
      );
    }
    if (!this.#outstandingIds.has(id)) {
      if (this.#allIds.has(id)) {
        throw new Error(
          'release(): message ' +
            JSON.stringify(id) +
            ' is not in the current take batch (its status is "' +
            this.#status.get(id) +
            '") — only unresolved messages from the most recent take() can be released.',
        );
      }
      throw new Error('release(): unknown message id ' + JSON.stringify(id) + '.');
    }
    for (const [token, mid] of this.#outstandingByToken) {
      if (mid === id) {
        this.#outstandingByToken.delete(token);
        break;
      }
    }
    this.#outstandingIds.delete(id);
    this.#status.set(id, 'released');
  }

  stats() {
    let committed = 0;
    let released = 0;
    for (const s of this.#status.values()) {
      if (s === 'committed') committed += 1;
      else if (s === 'released') released += 1;
    }
    return {
      pending: this.#pending.length + this.#outstandingByToken.size,
      committed,
      released,
    };
  }

  close() {
    this.#assertOpen('close');
    if (this.#outstandingByToken.size > 0) {
      throw new Error(
        'close() called with ' +
          this.#outstandingByToken.size +
          ' taken message(s) unresolved — commit(message.ackToken) or release(message.id) ' +
          'each of them first.',
      );
    }
    this.#closed = true;
  }

  // Internal audit hook for the seeded driver (run.mjs). Not part of
  // the documented SDK surface — workers should not need it.
  _audit() {
    return {
      closed: this.#closed,
      takeSizes: [...this.#takeSizes],
      statuses: Object.fromEntries(this.#status),
    };
  }
}

export function connect(url) {
  if (typeof url !== 'string' || !url.startsWith('quill://')) {
    throw new Error(
      "connect() expects a quill:// connection string, e.g. connect('quill://local') — got " +
        JSON.stringify(url) +
        '.',
    );
  }
  return new QuillClient(SEED_MESSAGES);
}

export const SEEDED_MESSAGES = SEED_MESSAGES.map((m) => ({ id: m.id, body: m.body }));
`;

export const QUILL_RUN_MJS = `// Read-only driver — DO NOT MODIFY. The scenario checker compares this
// file byte-for-byte against the seed, then runs 'node run.mjs': it
// imports the worker from ./worker.mjs, drives it against a fresh Quill
// client, and audits the outcome. Failures print as 'CASE n: ...' and
// exit non-zero.
import { connect, SEEDED_MESSAGES } from './lib/quill.mjs';

const SPAM_RE = /spam/i;
const failures = [];
function fail(n, msg) {
  failures.push('CASE ' + n + ': ' + msg);
}
function finish() {
  if (failures.length > 0) {
    for (const f of failures) console.log(f);
    console.log(failures.length + ' CHECK(S) FAILED');
    process.exitCode = 1;
  } else {
    console.log('ALL CHECKS PASSED');
  }
}

let workerFn = null;
try {
  const mod = await import('./worker.mjs');
  workerFn = mod.worker;
  if (typeof workerFn !== 'function') {
    fail(
      1,
      'worker.mjs must export a function named "worker" — export async function worker(client) ' +
        '{ ... } — got ' +
        typeof workerFn +
        '.',
    );
    workerFn = null;
  }
} catch (err) {
  fail(1, 'could not import ./worker.mjs: ' + String((err && err.message) || err));
}
if (workerFn === null) {
  finish();
} else {
  const client = connect('quill://local');
  try {
    await workerFn(client);
  } catch (err) {
    fail(2, 'worker(client) threw: ' + String((err && err.message) || err));
  }

  const stats = client.stats();
  const audit = client._audit();
  const expectedSpam = SEEDED_MESSAGES.filter((m) => SPAM_RE.test(m.body));
  const expectedHam = SEEDED_MESSAGES.filter((m) => !SPAM_RE.test(m.body));

  if (stats.pending !== 0) {
    fail(3, 'queue not drained: stats().pending is ' + stats.pending + ', expected 0.');
  }
  if (stats.committed !== expectedHam.length) {
    fail(
      4,
      'stats().committed is ' +
        stats.committed +
        ', expected ' +
        expectedHam.length +
        ' (every non-spam message must be committed via its ackToken).',
    );
  }
  if (stats.released !== expectedSpam.length) {
    fail(
      5,
      'stats().released is ' +
        stats.released +
        ', expected ' +
        expectedSpam.length +
        ' (every message whose body matches /spam/i must be released by id).',
    );
  }

  const misfiled = [];
  for (const m of expectedHam) {
    if (audit.statuses[m.id] !== 'committed') {
      misfiled.push(m.id + ' should be committed but is ' + audit.statuses[m.id]);
    }
  }
  for (const m of expectedSpam) {
    if (audit.statuses[m.id] !== 'released') {
      misfiled.push(m.id + ' (spam) should be released but is ' + audit.statuses[m.id]);
    }
  }
  if (misfiled.length > 0) {
    fail(
      6,
      'per-message audit: ' +
        misfiled.slice(0, 4).join('; ') +
        (misfiled.length > 4 ? ' (+' + (misfiled.length - 4) + ' more)' : '') +
        '.',
    );
  }

  if (client.closed !== true) {
    fail(7, 'client.close() was never called — the worker must close the client after draining.');
  }

  const badTakes = audit.takeSizes.filter((n) => n !== 5);
  if (audit.takeSizes.length === 0 || badTakes.length > 0) {
    fail(
      8,
      'take() batch sizes were [' +
        audit.takeSizes.join(', ') +
        '] — the worker must always request batches of 5: client.take(5).',
    );
  }

  finish();
}
`;

// ─────────────────────────────────────────────────────────────────────
// User-shaped task text (single-sourced into missionObjectives + kickoff).

const QUILL_RULES = [
  '1. Always take in batches of 5: call client.take(5).',
  ' 2. Release every spam message — any message whose body matches /spam/i — with',
  ' client.release(message.id).',
  ' 3. Commit every other (non-spam) message via its ackToken: client.commit(message.ackToken).',
  ' 4. Resolve every message from the current batch before taking the next, and keep taking',
  ' until client.take(5) returns an empty array.',
  ' 5. Finally call client.close() exactly once.',
].join('');

export const FICTIONAL_SDK_MISSION_OBJECTIVES = [
  `Write ${WORKER_PATH} at the workspace root: a queue worker for the Quill message-queue SDK.`,
  `It must export exactly \`export async function worker(client)\`. Read ${DOCS_PATH} first and`,
  'follow it precisely — Quill is an in-house SDK and its method signatures deliberately do not',
  'match other queue libraries (for example, commit() takes the ackToken minted by take(), not',
  'the message id, and release() takes the message id, not the ackToken). The worker drains the',
  `queue per these rules: ${QUILL_RULES}`,
  `Do not modify ${DOCS_PATH}, ${LIB_PATH}, or ${RUN_PATH}.`,
].join(' ');

export const FICTIONAL_SDK_KICKOFF_MESSAGE = [
  `Please write our Quill queue worker. Create ${WORKER_PATH} at the workspace root (path`,
  'relative to the workspace root, no leading "workspace/") exporting exactly',
  '`export async function worker(client)` — the supplied client is already connected.',
  `Read ${DOCS_PATH} FIRST and code strictly against it: Quill is our in-house SDK and its API`,
  'intentionally differs from queue libraries you may know; lib/quill.mjs throws on any',
  `mismatched usage. The worker must drain the queue per these five rules: ${QUILL_RULES}`,
  `Do NOT modify ${DOCS_PATH}, ${LIB_PATH}, or ${RUN_PATH} — they are read-only and checked`,
  'byte-for-byte. No npm installs; plain Node only. The checker runs `node run.mjs`',
  `automatically whenever ${WORKER_PATH} changes and reports any failing CASE lines back to you`,
  'via chat.',
].join(' ');

// ─────────────────────────────────────────────────────────────────────
// Grader.

export const FICTIONAL_SDK_SIGNALS = [
  'docs-untouched',
  'lib-untouched',
  'run-untouched',
  'worker-present',
  'run-green',
] as const;

export interface QuillCheckResult {
  ok: boolean;
  signals: string[];
  score: number;
  failReason?: string;
  missingRequiredSignals?: string[];
  /** Failing `CASE n:` lines from run.mjs, verbatim. */
  caseFailures?: string[];
}

async function readDirText(dir: string, rel: string): Promise<string | null> {
  try {
    return await readFile(join(dir, rel), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Offline verification of a fictional-sdk workspace DIRECTORY (no
 * daemon): byte-identical guards on the three seeded files, then the
 * run.mjs runtime gate against the model's worker.mjs. Exported so the
 * grader tests can execute the exact production gate locally.
 */
export async function verifyQuillDir(dir: string): Promise<QuillCheckResult> {
  const signals: string[] = [];
  const fail = (
    missing: string[],
    failReason: string,
    extra: Partial<QuillCheckResult> = {},
  ): QuillCheckResult => ({
    ok: false,
    signals,
    score: signals.length,
    failReason,
    missingRequiredSignals: missing,
    ...extra,
  });

  const [docs, lib, run] = await Promise.all([
    readDirText(dir, DOCS_PATH),
    readDirText(dir, LIB_PATH),
    readDirText(dir, RUN_PATH),
  ]);
  const guardFailures: string[] = [];
  if (docs !== null && docs.trim() === QUILL_DOCS_MD.trim()) signals.push('docs-untouched');
  else guardFailures.push('docs-untouched');
  if (lib !== null && lib.trim() === QUILL_LIB_MJS.trim()) signals.push('lib-untouched');
  else guardFailures.push('lib-untouched');
  if (run !== null && run.trim() === QUILL_RUN_MJS.trim()) signals.push('run-untouched');
  else guardFailures.push('run-untouched');
  if (guardFailures.length > 0) {
    const named = guardFailures
      .map((g) =>
        g === 'docs-untouched' ? DOCS_PATH : g === 'lib-untouched' ? LIB_PATH : RUN_PATH,
      )
      .join(', ');
    return fail(
      guardFailures,
      `${named} ${guardFailures.length === 1 ? 'was' : 'were'} modified or deleted — these files are read-only; restore them exactly as seeded and put all your code in ${WORKER_PATH}`,
    );
  }

  const worker = await readDirText(dir, WORKER_PATH);
  if (worker === null) {
    return fail(
      ['worker-present'],
      `${WORKER_PATH} does not exist at the workspace root yet — it must export async function worker(client)`,
    );
  }
  signals.push('worker-present');

  const runResult = await spawnAndAwait(process.execPath, [join(dir, RUN_PATH)], {
    cwd: dir,
    timeoutMs: 30_000,
  });
  if (runResult.exitCode !== 0) {
    const caseFailures = runResult.stdout.split('\n').filter((l) => /^CASE \d+:/.test(l));
    const detail =
      caseFailures.length > 0
        ? caseFailures.join(' | ')
        : `run.mjs ${runResult.timedOut ? 'timed out after 30 s (is the worker looping?)' : `exited ${runResult.exitCode}`}: ${(runResult.stderr || runResult.stdout).trim().slice(0, 400)}`;
    return fail(['run-green'], `node run.mjs failed — ${detail}`, { caseFailures });
  }
  signals.push('run-green');

  return { ok: true, signals, score: signals.length };
}

// ─────────────────────────────────────────────────────────────────────

async function findProjectId(client: GezelClient): Promise<string | null> {
  const { projects } = await client.listProjects();
  return projects.find((p) => p.name === PROJECT_NAME)?.id ?? null;
}

async function readWorkspaceText(
  client: GezelClient,
  projectId: string,
  filePath: string,
): Promise<string | null> {
  try {
    const blob = await client.fetchProjectWorkspaceBlob(projectId, filePath);
    return await blob.text();
  } catch {
    return null;
  }
}

/** Tiny FNV-1a content hash for the run-once-per-revision cache key. */
function simpleHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

async function setup({ client, log }: EvalContext): Promise<void> {
  const trustedRunner = trustedCheckRunnerEnabled();
  let projectId = await findProjectId(client);
  if (!projectId) {
    const created = await client.createProject({
      name: PROJECT_NAME,
      about:
        'Implement a queue worker against Quill, our in-house message-queue SDK, using only its ' +
        'seeded documentation and in-memory client — the API deliberately does not match other ' +
        'queue libraries, so the docs are the only reliable source.',
      missionObjectives: FICTIONAL_SDK_MISSION_OBJECTIVES,
    });
    projectId = created.id;
    log(`[scenario:setup] created project name="${PROJECT_NAME}" id=${projectId}`);
  } else {
    log(`[scenario:setup] reusing existing project id=${projectId}`);
  }
  if (!projectId) throw new Error('fictional-sdk setup: failed to resolve project id');

  const seedFiles: Array<{ path: string; content: string }> = [
    { path: DOCS_PATH, content: QUILL_DOCS_MD },
    { path: LIB_PATH, content: QUILL_LIB_MJS },
    { path: RUN_PATH, content: QUILL_RUN_MJS },
  ];
  for (const f of seedFiles) {
    await client.writeProjectWorkspaceFile(projectId, f);
  }
  log(`[scenario:setup] seeded ${seedFiles.length} fixture files under project ${projectId}`);

  let dev: { id: string };
  try {
    const created = await client.createGezel({ name: DEVELOPER_NAME, role: 'Developer' });
    dev = { id: created.id };
    log(`[scenario:setup] created developer "${DEVELOPER_NAME}" id=${dev.id}`);
  } catch (err) {
    const { gezels } = await client.listGezels();
    const existing = gezels.find((g) => g.name === DEVELOPER_NAME);
    if (!existing) throw err;
    dev = { id: existing.id };
    log(`[scenario:setup] reusing developer "${DEVELOPER_NAME}" id=${dev.id}`);
  }
  await client.addGezelToProject(projectId, dev.id);
  log(`[scenario:setup] joined ${DEVELOPER_NAME} to project ${projectId}`);

  await client.sendChatMessage(dev.id, {
    message: trustedRunner
      ? `${FICTIONAL_SDK_KICKOFF_MESSAGE} ${TRUSTED_RUNNER_KICKOFF}`
      : FICTIONAL_SDK_KICKOFF_MESSAGE,
    projectId,
    ...(trustedRunner
      ? {
          expectedDeliverable: {
            kind: 'file' as const,
            filePath: WORKER_PATH,
            scripts: [
              {
                name: 'checkWorkspaceScript',
                scope: 'standard' as const,
                inputs: {
                  script: RUN_PATH,
                  expectedSource: QUILL_RUN_MJS,
                  timeoutMs: 120_000,
                },
              },
            ],
          },
        }
      : {}),
  });
  log(`[scenario:setup] sent kickoff to ${DEVELOPER_NAME} in project ${projectId}`);
}

/** Run-once-per-revision cache; the hash covers the guards too, so any tamper re-runs the gate. */
const gateCache = new WeakMap<EvalContext, { lastHash: string; lastResult: QuillCheckResult }>();

export const fictionalSdkScenario: EvalScenario = {
  id: 'fictional-sdk',
  description:
    'Doc-grounded coding against a fictional message-queue SDK ("Quill") whose semantics cut ' +
    'against memorized idioms (commit takes the ackToken, release takes the id): write ' +
    'worker.mjs draining the seeded queue per 5 rules; graded by the read-only run.mjs driver ' +
    'executing the worker against the instrumented stub.',
  prompt: [
    `Heads up: ${DEVELOPER_NAME} is writing the Quill queue worker in the "${PROJECT_NAME}"`,
    "project against the seeded SDK docs. You don't need to do anything — just confirm you've",
    'seen this note.',
  ].join(' '),
  evidenceTexts: [FICTIONAL_SDK_KICKOFF_MESSAGE, FICTIONAL_SDK_MISSION_OBJECTIVES],
  timeoutMs: 20 * 60_000,
  progressTimeoutMs: 10 * 60_000,
  setup,
  skipInitialPrompt: true,
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const { client, log, logChanged, recordSniff } = ctx;
    const projectId = await findProjectId(client);
    if (!projectId) {
      logChanged('project', '[scenario] fictional-sdk project not present yet');
      return { done: false };
    }

    const [docs, lib, run, worker] = await Promise.all([
      readWorkspaceText(client, projectId, DOCS_PATH),
      readWorkspaceText(client, projectId, LIB_PATH),
      readWorkspaceText(client, projectId, RUN_PATH),
      readWorkspaceText(client, projectId, WORKER_PATH),
    ]);

    if (worker === null) {
      logChanged(
        'sniff',
        `[scenario] fictional-sdk bytes=0 score=0 signals=none (no ${WORKER_PATH} yet)`,
      );
      recordSniff?.({ key: 'fictional-sdk', score: 0, bytes: 0 });
      await postMissingDeliverableFeedback(ctx, WORKER_PATH, { projectId });
      return { done: false };
    }

    const hash = simpleHash(`${docs ?? ''}\u0000${lib ?? ''}\u0000${run ?? ''}\u0000${worker}`);
    let result: QuillCheckResult;
    const cached = gateCache.get(ctx);
    if (cached && cached.lastHash === hash) {
      result = cached.lastResult;
    } else {
      const tmp = await mkdtemp(`${tmpdir()}/gezel-eval-fictional-sdk-`);
      try {
        await materializeProjectWorkspace(client, projectId, tmp, {
          include: /\.(m?js|c?js|json|md)$/,
        });
        result = await verifyQuillDir(tmp);
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => {});
      }
      gateCache.set(ctx, { lastHash: hash, lastResult: result });
      log(`[scenario] fictional-sdk run.mjs gate ran: ok=${result.ok}`);
    }

    logChanged(
      'sniff',
      `[scenario] fictional-sdk bytes=${worker.length} score=${result.score}/${FICTIONAL_SDK_SIGNALS.length} signals=${result.signals.join(',') || 'none'}${result.failReason ? ` failReason="${result.failReason}"` : ''}`,
    );
    recordSniff?.({
      key: 'fictional-sdk',
      score: result.score,
      bytes: worker.length,
      ...(result.failReason ? { failReason: result.failReason } : {}),
    });

    if (result.ok) {
      return {
        done: true,
        success: true,
        reason: `node run.mjs passed all checks against ${WORKER_PATH} (${result.signals.join(', ')})`,
      };
    }

    await postSniffFeedback(ctx, WORKER_PATH, result, {
      projectId,
      sourceText: worker,
    });
    return { done: false };
  },
};
