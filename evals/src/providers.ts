/**
 * Chat-provider abstraction for the eval harness.
 *
 * The runner used to hard-code an `engine: 'llama-cpp' | 'mlx'` branch
 * everywhere. Once we needed to drive cloud and CLI-wrapper providers
 * (codex-cli, anthropic-cli, anthropic SDK, openai SDK, copilot), the
 * branches multiplied — each provider has a different config shape, a
 * different auth model, and a different relationship to the perf
 * collector. This module pulls those three concerns into one place so
 * `runner.ts` can stay a thin orchestrator.
 *
 * Not exported: `ollama`. The Ollama eval path has its own driver
 * (`bin/run-ollama.ts`) for historical reasons; folding it into the
 * matrix runner is a separate piece of work.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GezelConfig } from '@bendyline/gezel';

/**
 * Claude Code 2.x stores its OAuth credentials in the macOS keychain
 * (generic-password service `Claude Code-credentials`), not in a file —
 * so the file-based checks in `probeProviderAuth` miss a perfectly
 * logged-in CLI and the probe false-fails before the trial ever spawns
 * `claude` (which reads the keychain itself). Detect the keychain entry
 * on darwin so the probe matches reality. Cheap local keychain metadata
 * read; never prints the secret.
 */
function hasMacKeychainClaudeCreds(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], {
      stdio: 'ignore',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every chat provider the eval harness can target. Drives `--provider`
 * validation, per-provider config rendering, and the local-engine
 * pipeline gate.
 */
export const CHAT_PROVIDERS = [
  'llama-cpp',
  'mlx',
  'ds4',
  'codex-cli',
  'anthropic-cli',
  'copilot',
  'anthropic',
  'openai',
] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];

/**
 * Coarse category that determines which phases of the trial runner
 * apply:
 *
 *  - `local-engine` — binary probe, warm-cache, model linking, GPU /
 *    process perf sampling. The model runs in-process inside our
 *    trial daemon.
 *  - `cli-wrapper` — no warm-cache (model is remote), but the daemon
 *    still spawns a per-turn subprocess (`codex`, `claude`) we'd be
 *    misleading to sample (subprocess lives ms to seconds, never the
 *    full trial). Auth comes from the CLI's own login files or env.
 *  - `cloud-sdk` — pure HTTP. Nothing local to probe or sample. Auth
 *    is one API key in env (plus an optional org id for OpenAI), or
 *    the user's `gh copilot` login state for Copilot.
 */
export type ProviderCategory = 'local-engine' | 'cli-wrapper' | 'cloud-sdk';

export function isChatProvider(value: string): value is ChatProvider {
  return (CHAT_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The default local engine when the user runs an eval without `--provider`.
 *
 * Platform-aware on purpose: an Apple Silicon Mac defaults to **MLX**, so a
 * `pnpm eval:run`/`eval:all` on a Mac dev box or Mac CI exercises the MLX
 * path that only that hardware can run — without it, MLX gets zero default
 * coverage and only the llama.cpp path (covered on the lab's Linux + Windows
 * boxes) is ever hit. Everything else defaults to llama.cpp. Intel Macs
 * (`darwin`/`x64`) cannot run MLX, so they stay on llama.cpp too.
 *
 * Mirrors `bin/ab-grammar.ts`, which already defaults to `mlx` for its
 * MLX-specific grammar A/B.
 */
export function defaultProvider(): ChatProvider {
  return process.platform === 'darwin' && process.arch === 'arm64' ? 'mlx' : 'llama-cpp';
}

export function categorizeProvider(p: ChatProvider): ProviderCategory {
  if (p === 'llama-cpp' || p === 'mlx' || p === 'ds4') return 'local-engine';
  if (p === 'codex-cli' || p === 'anthropic-cli') return 'cli-wrapper';
  return 'cloud-sdk';
}

export function isLocalEngine(p: ChatProvider): boolean {
  return categorizeProvider(p) === 'local-engine';
}

/**
 * Providers that run their OWN internal agent loop (plan→act→observe)
 * inside a single CLI/SDK invocation, surfacing gezel-visible activity
 * only coarsely — roughly once per invocation. For these, a long stretch
 * of silence is NOT a hang: one invocation building a substantial
 * deliverable can run many minutes without a gezel-level heartbeat. The
 * soft-progress (silence) watchdog, tuned for chatty raw-completion
 * models that emit a turn every few seconds, must therefore give these
 * providers a much larger window — interpreting their silence as a stall
 * false-failed codex-cli tankcombat at 301s (it re-ran PASS in 113s). The
 * HARD progress watchdog (real product progress) stays the true backstop.
 *
 * NB: this is a finer cut than `categorizeProvider` — `copilot` is a
 * `cloud-sdk` but DOES self-orchestrate, whereas raw cloud APIs
 * (`anthropic`, `openai`) do not: gezel drives their loop one turn per
 * step, so the default silence window fits them.
 */
export function isSelfOrchestratingProvider(p: ChatProvider): boolean {
  return p === 'codex-cli' || p === 'anthropic-cli' || p === 'copilot';
}

/**
 * Default chat model id for each provider. Used when the user runs
 * `pnpm eval:run <scenario>` with `--provider <p>` but no `--model`.
 *
 * llama-cpp keeps the Gemma-4 E4B slot as its default, now `gemma4-e4b-q4`.
 * Postmortems written before the QAT-Q4 swap were calibrated against the
 * Q8_0 weights this id used to name, so treat scores across that boundary as
 * a different baseline rather than a continuous series. MLX uses the smaller
 * `qwen3.5-4b-q4` as its fast default; both it and Gemma-4 E4B now ship
 * working MLX sources, so explicit E4B trials remain available. Cloud / CLI
 * providers pick a current flagship that's a reasonable fit for the anchored
 * scenarios.
 *
 * If a provider is added here, also extend the model-id-to-display-name
 * surface in the catalog so the postmortem renders the right label.
 */
export function defaultModelFor(p: ChatProvider): string {
  switch (p) {
    case 'llama-cpp':
      return 'gemma4-e4b-q4';
    case 'mlx':
      return 'qwen3.5-4b-q4';
    case 'ds4':
      return 'deepseek-v4-flash-284b-q2';
    case 'codex-cli':
      return 'gpt-5.5';
    case 'anthropic-cli':
      // The `claude` CLI only accepts an alias ('sonnet') or the canonical
      // dashed full id — NOT the dot form 'claude-sonnet-4.6' (which the
      // copilot/codex SDKs happen to tolerate). A dot-form id fails the
      // turn with "issue with the selected model … may not exist". Match
      // the `anthropic` raw-SDK default, which is already dashed.
      return 'claude-sonnet-4-6';
    case 'copilot':
      return 'claude-sonnet-4.6';
    case 'anthropic':
      return 'claude-sonnet-4-6';
    case 'openai':
      return 'gpt-5';
  }
}

/**
 * Build the partial `updateConfig` payload that switches a fresh
 * trial daemon to the requested provider. Returns ONLY the
 * provider-related fields — the caller still merges in things like
 * `imageProvider` (which is independent of chat provider) and
 * `firstRunCompleted`.
 *
 * Note the `defaultModel` map key matches the provider name exactly
 * — every provider gets ONE entry in that map keyed by its own name.
 * Don't multiplex (e.g. setting both `copilot` and `openai` defaults
 * in a single trial) — the runtime uses `provider` to pick, but the
 * matrix runner has historically had one provider per trial and the
 * postmortem expects that 1:1 relationship.
 *
 * For CLI-wrapper providers (`codex-cli`, `anthropic-cli`), the payload
 * also pins `defaultPermissionMode: 'bypassPermissions'`. The eval
 * harness is non-interactive — there's no human to approve a tool
 * call — so the default `acceptEdits` mode causes MCP tool calls
 * (`start_project`, `message_gezel`, etc.) to be silently cancelled
 * with `user cancelled MCP tool call`. The first codex smoke trial
 * burned the full 5-minute soft-progress budget with zero turns
 * because of exactly this. Bypass is safe here: trial homes are
 * mktemp'd and torn down on exit.
 */
export function buildProviderConfig(provider: ChatProvider, modelId: string): Partial<GezelConfig> {
  const base: Partial<GezelConfig> = {
    provider,
    defaultModel: { [provider]: modelId },
  };
  // A/B knob for KV-cache quantization experiments (mlxKvBits sweep,
  // 2026-08): set GEZEL_EVAL_MLX_KV_BITS=8 to run the whole trial with
  // quantized KV. Eval-harness-only — the product default stays whatever
  // config.mlxKvBits says. Unset = engine default (f16).
  const kvBitsRaw = process.env.GEZEL_EVAL_MLX_KV_BITS;
  if (provider === 'mlx' && kvBitsRaw) {
    const kvBits = Number(kvBitsRaw);
    if (Number.isInteger(kvBits) && kvBits > 0) base.mlxKvBits = kvBits;
  }
  if (provider === 'codex-cli') {
    return {
      ...base,
      codexCli: { defaultPermissionMode: 'bypassPermissions' },
    };
  }
  if (provider === 'anthropic-cli') {
    return {
      ...base,
      anthropicCli: { defaultPermissionMode: 'bypassPermissions' },
    };
  }
  return base;
}

export interface ProviderAuthProbeResult {
  ok: boolean;
  /** Human-readable message — surfaced verbatim on failure, ignored on success. */
  message: string;
}

/**
 * Pre-flight auth probe. Cheap, env-only — does NOT spawn the CLI
 * binary or hit a network endpoint. The intent is to catch "you
 * forgot to export ANTHROPIC_API_KEY" before a 25-minute trial fails
 * on the first chat turn, not to perfectly mirror the runtime's auth
 * resolution.
 *
 * On failure, the trial runner aborts before model-warm. On success,
 * the trial proceeds and any deeper auth issue surfaces from the
 * service's own boot path.
 */
export function probeProviderAuth(
  provider: ChatProvider,
  env: NodeJS.ProcessEnv = process.env,
): ProviderAuthProbeResult {
  switch (provider) {
    case 'llama-cpp':
    case 'mlx':
    case 'ds4':
      // Local engines have no auth — model weights are it.
      return { ok: true, message: '' };

    case 'openai': {
      if (env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim().length > 0) {
        return { ok: true, message: '' };
      }
      return {
        ok: false,
        message:
          'OpenAI provider requires OPENAI_API_KEY in the environment. ' +
          'Export it (`export OPENAI_API_KEY=sk-...`) and re-run.',
      };
    }

    case 'anthropic': {
      if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim().length > 0) {
        return { ok: true, message: '' };
      }
      return {
        ok: false,
        message:
          'Anthropic provider requires ANTHROPIC_API_KEY in the environment. ' +
          'Export it (`export ANTHROPIC_API_KEY=sk-ant-...`) and re-run.',
      };
    }

    case 'codex-cli': {
      // codex picks credentials in this order: CODEX_API_KEY,
      // OPENAI_API_KEY, then `~/.codex/auth.json` (written by
      // `codex login`). Any one of these is enough.
      if (env.CODEX_API_KEY || env.OPENAI_API_KEY) return { ok: true, message: '' };
      const codexHome = env.CODEX_HOME ?? join(homedir(), '.codex');
      if (existsSync(join(codexHome, 'auth.json'))) return { ok: true, message: '' };
      return {
        ok: false,
        message: `codex-cli requires one of: CODEX_API_KEY env var, OPENAI_API_KEY env var, or an authenticated ${join(codexHome, 'auth.json')} (run \`codex login\`).`,
      };
    }

    case 'anthropic-cli': {
      if (env.ANTHROPIC_API_KEY) return { ok: true, message: '' };
      // `claude login` writes credentials to ~/.claude/.credentials.json;
      // older installs may have ~/.claude/config.json. Either is enough
      // to satisfy the CLI on first turn.
      const claudeHome = join(homedir(), '.claude');
      if (
        existsSync(join(claudeHome, '.credentials.json')) ||
        existsSync(join(claudeHome, 'config.json'))
      ) {
        return { ok: true, message: '' };
      }
      // Claude Code 2.x keeps creds in the macOS keychain, not a file.
      if (hasMacKeychainClaudeCreds()) return { ok: true, message: '' };
      return {
        ok: false,
        message: `anthropic-cli requires ANTHROPIC_API_KEY env var, an authenticated ${claudeHome} (\`claude login\`), or macOS keychain credentials (Claude Code 2.x).`,
      };
    }

    case 'copilot': {
      // The Copilot provider reads the user's `gh` login (token lives
      // under ~/.config/gh on POSIX / %APPDATA%\GitHub CLI on Windows)
      // OR `GH_TOKEN` / `GITHUB_TOKEN` in env. We don't try to parse
      // gh's config — we just check the env or the platform's
      // default config dir.
      if (env.GH_TOKEN || env.GITHUB_TOKEN) return { ok: true, message: '' };
      const ghConfigDir =
        env.GH_CONFIG_DIR ??
        (process.platform === 'win32'
          ? join(env.APPDATA ?? '', 'GitHub CLI')
          : join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'gh'));
      if (existsSync(join(ghConfigDir, 'hosts.yml'))) return { ok: true, message: '' };
      return {
        ok: false,
        message:
          'copilot provider requires a `gh auth login` (then `gh copilot` access) ' +
          'or GH_TOKEN / GITHUB_TOKEN in the environment.',
      };
    }
  }
}
