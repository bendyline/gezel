/**
 * A/B micro-harness for the Theme F decode-throughput levers on the local
 * llama-cpp engine. Isolates each engine knob — single-slot (+ auto
 * cache-reuse), flash-attn, ubatch, and speculative decoding — on
 * `gemma4-e4b-q8` and reports decode t/s, prefill t/s, generated tokens,
 * and (for spec-decode) draft acceptance + output identity vs the greedy
 * baseline.
 *
 * Why raw `/v1/chat/completions`, not the agent loop: the levers are
 * ENGINE properties. Holding the WORK constant across arms is the only way
 * to read a clean decode-t/s delta, and the agent loop's tool decisions
 * vary the token count per run. So each arm sends the SAME fixed prompts at
 * temperature 0 through gezel's OpenAI-compat endpoint — a
 * `<provider>:<model>` ref gets `systemPrefix=''`, i.e. near-raw
 * generation — and we parse llama-server's per-request `prompt eval time` /
 * `eval time` timing lines out of `daemon.log`. Length + greedy sampling
 * come from per-model `modelTuning` (the `/v1` route rejects per-request
 * sampling by design), so both are identical across arms.
 *
 * Levers map to `config` fields resolved in
 * providers/llama-cpp/engine-flags.ts:
 *   - slots        → providerConcurrency['llama-cpp']   (1 auto-enables --cache-reuse 256)
 *   - flash-attn   → llamaCppFlashAttn
 *   - ubatch       → llamaCppUbatchSize
 *   - spec-decode  → llamaCppSpecType + llamaCppDraftModelPath (+ nMax)
 *
 * Run (GPU, from repo root — needs the CUDA binary + its .so dir on
 * LD_LIBRARY_PATH, using Node 22 or newer):
 *   GEZEL_LLAMA_SERVER_BIN=$PWD/native/build/linux-arm64-cuda/gezel-llama-server \
 *   LD_LIBRARY_PATH=$PWD/native/build/linux-arm64-cuda \
 *   pnpm --filter @bendyline/gezel-evals exec tsx src/bin/ab-decode-levers.ts [arm...]
 *
 * With no args, runs the full arm set. Pass a subset of arm names to run
 * only those (baseline is always run first as the reference).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { acquireEvalDeviceLock } from '../eval-device-lock.ts';
import { defaultCacheRoot, ensureWarmModel, linkModelIntoTrial } from '../model-cache.ts';
import { resolveLlamaBinary } from '../native-bin.ts';
import { shutdownTrialDaemon, spawnTrialDaemon } from '../spawn.ts';

const MODEL = 'gemma4-e4b-q8';
const MODEL_REF = `llama-cpp:${MODEL}`;
// The draft partner for draft-simple: same Gemma-4 family / tokenizer, ~2B
// effective params. Warm-cached at this absolute path; passed verbatim to
// --spec-draft-model, so no per-trial linking is needed.
const DRAFT_GGUF = join(
  defaultCacheRoot(),
  'engines',
  'llama-cpp',
  'models',
  'gemma4-e2b',
  'gemma-4-E2B-it-Q8_0.gguf',
);
const MAX_TOKENS = 320;
const REQUEST_TIMEOUT_MS = 180_000;

// Distinct, similar-shape coding prompts. Distinct (not repeated) so every
// request cold-prefills its own prompt — otherwise cache-reuse would skip
// prefill on repeats and leave prefill t/s with a single sample. Code is
// also the representative decode workload and the interesting case for
// draft acceptance (predictable tokens → higher acceptance than free prose).
const PROMPTS = [
  'Write a Python function bubble_sort(arr) with a docstring and inline comments explaining each step. Output only the code.',
  'Write a Python function merge_sort(arr) with a docstring and inline comments explaining each step. Output only the code.',
  'Write a Python function quick_sort(arr) with a docstring and inline comments explaining each step. Output only the code.',
  'Write a Python function binary_search(arr, target) with a docstring and inline comments explaining each step. Output only the code.',
];

/** A config/env patch that turns one lever on, layered over the baseline. */
interface Arm {
  name: string;
  // biome-ignore lint/suspicious/noExplicitAny: config patch is intentionally partial + open
  config: Record<string, any>;
  extraEnv?: Record<string, string>;
}

const BASELINE_TUNING = {
  [MODEL]: {
    sampling: { temperature: 0, maxTokens: MAX_TOKENS },
    reasoning: { enableThinking: false },
  },
};

function armSet(): Arm[] {
  return [
    // Reference: whatever the RAM-tier default resolves to (4 slots on a
    // 64GB+ box), no spec, flash-attn/ubatch at server defaults.
    { name: 'baseline', config: {} },
    // Single-slot: 4× less KV reserved, and engine-flags auto-enables
    // --cache-reuse 256 (gated to slots===1).
    { name: 'slots1', config: { providerConcurrency: { 'llama-cpp': 1 } } },
    // Single-slot + flash-attn forced on.
    {
      name: 'slots1-fa',
      config: { providerConcurrency: { 'llama-cpp': 1 }, llamaCppFlashAttn: 'on' },
    },
    // Single-slot + a wider inner microbatch (server default 512 → 1024)
    // to exploit the GB10's compute headroom during prefill.
    {
      name: 'slots1-ubatch1024',
      config: { providerConcurrency: { 'llama-cpp': 1 }, llamaCppUbatchSize: 1024 },
    },
    // Single-slot + draft-simple speculative decoding (gemma4-e2b draft).
    {
      name: 'slots1-spec-e2b',
      config: {
        providerConcurrency: { 'llama-cpp': 1 },
        llamaCppSpecType: 'draft-simple',
        llamaCppDraftModelPath: DRAFT_GGUF,
        llamaCppSpecDraftNMax: 4,
      },
    },
    // Best-of: single-slot + flash-attn + spec (the likely default stack).
    {
      name: 'slots1-fa-spec',
      config: {
        providerConcurrency: { 'llama-cpp': 1 },
        llamaCppFlashAttn: 'on',
        llamaCppSpecType: 'draft-simple',
        llamaCppDraftModelPath: DRAFT_GGUF,
        llamaCppSpecDraftNMax: 4,
      },
    },
  ];
}

interface ReqTiming {
  promptTokens: number;
  promptMs: number;
  genTokens: number;
  genMs: number;
}

// llama-server prints, per request:
//   prompt eval time = 89150.04 ms / 15210 tokens ( 5.86 ms per token, 170.61 tokens per second)
//          eval time = 13234.12 ms /   210 tokens (63.02 ms per token,  15.87 tokens per second)
// We zip prefill+decode lines in stream order into one ReqTiming each.
const PROMPT_EVAL_RE = /prompt eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens/g;
const DECODE_EVAL_RE = /(?<!prompt )\beval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens/g;

function parsePerRequest(log: string): ReqTiming[] {
  const prefill = [...log.matchAll(PROMPT_EVAL_RE)].map((m) => ({
    ms: Number(m[1]),
    tokens: Number(m[2]),
  }));
  const decode = [...log.matchAll(DECODE_EVAL_RE)].map((m) => ({
    ms: Number(m[1]),
    tokens: Number(m[2]),
  }));
  // A request always emits a decode line; prefill may be skipped on a full
  // cache hit. Align by decode index and pair each with the prefill at the
  // same index when present (0 otherwise).
  return decode.map((d, i) => ({
    promptTokens: prefill[i]?.tokens ?? 0,
    promptMs: prefill[i]?.ms ?? 0,
    genTokens: d.tokens,
    genMs: d.ms,
  }));
}

/** Draft-acceptance lines the fork prints when spec-decode is active. */
function extractAcceptance(log: string): string[] {
  const out: string[] = [];
  for (const line of log.split('\n')) {
    if (/\b(n_draft|n_accept|accept|drafted|draft acceptance)\b/i.test(line)) {
      const t = line.replace(/^.*?\]/, '').trim();
      if (t) out.push(t);
    }
  }
  // Dedup adjacent repeats; keep the last few (per-request summaries).
  return [...new Set(out)].slice(-6);
}

interface ArmResult {
  name: string;
  decodeTps: number | null;
  prefillTps: number | null;
  genTokensAvg: number;
  promptTokensAvg: number;
  samples: number;
  responses: string[];
  acceptance: string[];
  launchFailed: boolean;
}

async function runArm(arm: Arm, llamaBin: string): Promise<ArmResult> {
  const home = await mkdtemp(join(tmpdir(), `gezel-decode-${arm.name}-`));
  const logPath = join(home, 'daemon.log');
  console.log(`\n=== ARM: ${arm.name} (home=${home}) ===`);
  const cacheRoot = defaultCacheRoot();
  await ensureWarmModel({
    cacheRoot,
    engine: 'llama-cpp',
    modelId: MODEL,
    llamaBin,
    log: () => {},
  });
  await linkModelIntoTrial({ cacheRoot, trialHome: home, engine: 'llama-cpp', modelId: MODEL });

  const responses: string[] = [];
  let launchFailed = false;
  const spawned = await spawnTrialDaemon({
    home,
    llamaBin,
    stderrLogPath: logPath,
    timeoutMs: 120_000,
    ...(arm.extraEnv ? { extraEnv: arm.extraEnv } : {}),
  });
  try {
    // biome-ignore lint/suspicious/noExplicitAny: client is loosely typed here
    const client: any = spawned.client;
    await client.updateConfig({
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': MODEL },
      firstRunCompleted: true,
      modelTuning: BASELINE_TUNING,
      ...arm.config,
    });

    // HTTPS daemon → trust the per-launch self-signed cert; plain-HTTP
    // daemon (no cert) → global fetch.
    const doFetch = spawned.cert ? createTrustingFetch({ cert: spawned.cert }) : fetch;
    const url = `${spawned.baseUrl}/v1/chat/completions`;
    for (let i = 0; i < PROMPTS.length; i++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${spawned.token}`,
          },
          body: JSON.stringify({
            model: MODEL_REF,
            messages: [{ role: 'user', content: PROMPTS[i] }],
            stream: false,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          console.warn(`[decode] ${arm.name} req#${i} HTTP ${res.status}: ${body.slice(0, 300)}`);
          if (i === 0) {
            launchFailed = true;
            break;
          }
          responses.push('');
          continue;
        }
        // biome-ignore lint/suspicious/noExplicitAny: OpenAI-compat response shape
        const json: any = await res.json();
        const content: string = json?.choices?.[0]?.message?.content ?? '';
        responses.push(content);
        console.log(`[decode] ${arm.name} req#${i}: ${content.length} chars generated`);
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    await shutdownTrialDaemon(spawned).catch(() => {});
  }

  const log = await readFile(logPath, 'utf8').catch(() => '');
  const perReq = parsePerRequest(log);
  // Drop request 0 (cold load / first-kernel-compile warmup).
  const measured = perReq.slice(1);
  const sum = (f: (r: ReqTiming) => number) => measured.reduce((a, r) => a + f(r), 0);
  const genTokens = sum((r) => r.genTokens);
  const genMs = sum((r) => r.genMs);
  const promptTokens = sum((r) => r.promptTokens);
  const promptMs = sum((r) => r.promptMs);
  const round2 = (n: number) => Math.round(n * 100) / 100;

  const result: ArmResult = {
    name: arm.name,
    decodeTps: genMs > 0 ? round2(genTokens / (genMs / 1000)) : null,
    prefillTps: promptMs > 0 ? round2(promptTokens / (promptMs / 1000)) : null,
    genTokensAvg: measured.length ? Math.round(genTokens / measured.length) : 0,
    promptTokensAvg: measured.length ? Math.round(promptTokens / measured.length) : 0,
    samples: measured.length,
    responses,
    acceptance: /spec/.test(arm.name) ? extractAcceptance(log) : [],
    launchFailed,
  };
  console.log(
    `[decode] ${arm.name}: decode ${result.decodeTps ?? 'n/a'} t/s · prefill ${result.prefillTps ?? 'n/a'} t/s · ${result.samples} samples`,
  );
  await rm(home, { recursive: true, force: true }).catch(() => {});
  return result;
}

function sameOutput(a: string[], b: string[]): { identical: boolean; firstDiff: number } {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if ((a[i] ?? '').trim() !== (b[i] ?? '').trim()) return { identical: false, firstDiff: i };
  }
  return { identical: a.length === b.length, firstDiff: -1 };
}

async function main(): Promise<void> {
  const deviceLock = acquireEvalDeviceLock();
  const llamaBin = resolveLlamaBinary().path;
  console.log(`[decode] llama-server = ${llamaBin}`);
  console.log(`[decode] draft gguf   = ${DRAFT_GGUF}`);

  const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const all = armSet();
  const arms =
    requested.length === 0
      ? all
      : all.filter((a) => a.name === 'baseline' || requested.includes(a.name));

  const results: ArmResult[] = [];
  for (const arm of arms) {
    results.push(await runArm(arm, llamaBin));
  }

  const baseline = results.find((r) => r.name === 'baseline');
  const pad = (s: string, n: number) => s.padEnd(n);
  const padL = (s: string, n: number) => s.padStart(n);

  console.log('\n================ DECODE-LEVER A/B RESULT (gemma4-e4b-q8, GPU) ================');
  console.log(
    `${pad('arm', 20)}${padL('decode t/s', 12)}${padL('Δ decode', 10)}${padL('prefill t/s', 14)}${padL('gen tok', 9)}${padL('n', 4)}`,
  );
  for (const r of results) {
    if (r.launchFailed) {
      console.log(`${pad(r.name, 20)}${padL('LAUNCH FAILED (see log above)', 46)}`);
      continue;
    }
    const dtps = r.decodeTps ?? 0;
    const bdtps = baseline?.decodeTps ?? 0;
    const delta =
      baseline && r.name !== 'baseline' && bdtps > 0
        ? `${(((dtps - bdtps) / bdtps) * 100).toFixed(1)}%`
        : '—';
    console.log(
      `${pad(r.name, 20)}${padL(String(r.decodeTps ?? 'n/a'), 12)}${padL(delta, 10)}${padL(String(r.prefillTps ?? 'n/a'), 14)}${padL(String(r.genTokensAvg), 9)}${padL(String(r.samples), 4)}`,
    );
  }
  console.log('=============================================================================');

  // Output-identity is INFORMATIONAL ONLY here. The `/v1` OpenAI-compat path
  // does not thread `modelTuning` into a raw `<provider>:<model>` session
  // (v1-chat.ts builds sessionOpts without `tuning`), so these arms sample at
  // llama-server's stochastic default — independent draws differ run-to-run
  // regardless of the lever, so a mismatch here says nothing about a lever's
  // correctness. draft-simple is lossless by construction (rejection-sampled
  // against the target distribution; see the acceptance log below). The real
  // correctness gate for a lever is the frozen ANCHOR pass-rate via the
  // gezel-session path (where tuning applies), run separately before default-on.
  if (baseline) {
    for (const r of results) {
      if (r.name === 'baseline' || r.launchFailed) continue;
      const cmp = sameOutput(baseline.responses, r.responses);
      console.log(
        `[identity] ${r.name}: ${cmp.identical ? 'text matched baseline' : `text differs (first at prompt #${cmp.firstDiff})`} — informational only (raw /v1 samples stochastically; gate on anchor pass-rate, not this)`,
      );
    }
  }

  // Draft acceptance (spec arms only).
  for (const r of results) {
    if (r.acceptance.length > 0) {
      console.log(`\n[acceptance] ${r.name}:`);
      for (const line of r.acceptance) console.log(`  ${line}`);
    }
  }
  deviceLock.release();
}

main().catch((err) => {
  console.error('[decode] failed:', err);
  process.exit(1);
});
