import { CHAT_PROVIDERS, type ChatProvider, isChatProvider, isLocalEngine } from '../providers.ts';
import type { EvalScenario } from '../types.ts';

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Tiny argv parser. Accepts `--key value`, `--key=value`, and bare `--key`
 * boolean flags. Single-dash flags are not supported — every flag in this
 * harness is a long form, intentionally explicit.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok) continue;
    // A bare `--` is the conventional end-of-flags separator, and pnpm
    // inserts one when forwarding through a wrapper script (`pnpm run x --
    // --suite core`). Parsing it as a flag named "" made strict validation
    // reject every leased invocation with "Unknown flag --".
    if (tok === '--') continue;
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq !== -1) {
        const key = tok.slice(2, eq);
        flags[key] = tok.slice(eq + 1);
      } else {
        const key = tok.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(tok);
    }
  }
  return { positional, flags };
}

/**
 * Flags consumed by the shared resolvers rather than read directly from
 * `flags` in a bin, so a bin's own flag list would otherwise miss them.
 */
export const SHARED_FLAGS = ['provider', 'engine', 'render-mode', 'keurmeester'] as const;

function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i]![j] =
        a[i - 1] === b[j - 1]
          ? rows[i - 1]![j - 1]!
          : 1 + Math.min(rows[i - 1]![j]!, rows[i]![j - 1]!, rows[i - 1]![j - 1]!);
    }
  }
  return rows[a.length]![b.length]!;
}

/**
 * Reject flags this bin does not understand.
 *
 * An unrecognized flag is silently dropped by `parseArgs`, so the run
 * proceeds on defaults while LOOKING like the experiment you asked for.
 * `--models a,b,c` on `eval:all` (which takes singular `--model`) spent
 * fifty minutes measuring the default model and produced a clean-looking
 * 0/3; the same class of mistake had `--llm-judge` riding along on every
 * scorecard sweep, read by nobody. Both are indistinguishable from a valid
 * result after the fact, which is exactly why this has to fail at argv
 * time rather than be caught by a careful reader.
 *
 * Value-level typos already exit here (see `resolveProviderFlag` and
 * friends); this is the same guarantee for the flag NAME.
 */
export function assertKnownFlags(
  flags: Record<string, string | boolean>,
  known: readonly string[],
): void {
  const allowed = new Set<string>([...known, ...SHARED_FLAGS]);
  const unknown = Object.keys(flags).filter((key) => !allowed.has(key));
  if (unknown.length === 0) return;
  for (const key of unknown) {
    const near = [...allowed]
      .map((candidate) => ({ candidate, distance: editDistance(key, candidate) }))
      .filter((entry) => entry.distance <= Math.max(2, Math.floor(key.length / 3)))
      .sort((a, b) => a.distance - b.distance)[0];
    console.error(`Unknown flag --${key}${near ? ` (did you mean --${near.candidate}?)` : ''}`);
  }
  console.error(
    `\nKnown flags: ${[...allowed]
      .sort()
      .map((k) => `--${k}`)
      .join(', ')}`,
  );
  process.exit(2);
}

/**
 * Parse a duration string like `30s`, `5m`, `2h`, or a raw millisecond
 * number. Returns ms.
 */
export function parseDuration(value: string): number {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)([smh])?$/);
  if (!match) {
    throw new Error(`unparseable duration: "${value}" (try "300000", "30s", "5m", "2h")`);
  }
  const n = Number(match[1]);
  const unit = match[2] ?? '';
  switch (unit) {
    case 's':
      return Math.round(n * 1000);
    case 'm':
      return Math.round(n * 60 * 1000);
    case 'h':
      return Math.round(n * 60 * 60 * 1000);
    default:
      return Math.round(n);
  }
}

/**
 * Resolve the `--render-mode flat|scaffold|auto` flag into a
 * `TrialOptions.executionDensity`. Returns `undefined` when unset (the
 * daemon then uses its own default, `scaffold`). Exits with a clear error
 * on an unknown value — a typo would otherwise silently fall through to
 * the default and quietly invalidate an A/B arm.
 */
export function resolveRenderModeFlag(
  flags: Record<string, string | boolean>,
): 'auto' | 'flat' | 'scaffold' | undefined {
  const raw = flags['render-mode'];
  if (raw === undefined || raw === true || raw === false) return undefined;
  const value = String(raw).trim();
  if (value.length === 0) return undefined;
  if (value !== 'auto' && value !== 'flat' && value !== 'scaffold') {
    console.error(`Unknown --render-mode "${value}". Expected one of: auto, flat, scaffold.`);
    process.exit(2);
  }
  return value;
}

/**
 * Resolve `--keurmeester <provider[/model]>` into
 * `TrialOptions.keurmeester` — the supervisor-arm lever. The provider
 * part is validated against the allowlist and must be a non-local
 * provider (a consult queued behind the stuck single-slot local engine
 * would deadlock the recovery it exists to provide); the optional
 * `/model` suffix pins the consult model. Exits with a clear error on
 * a bad value — a typo would silently run the control arm instead of
 * the treatment.
 */
export function resolveKeurmeesterFlag(
  flags: Record<string, string | boolean>,
): { providerName: ChatProvider; model?: string } | undefined {
  const raw = flags.keurmeester;
  if (raw === undefined || raw === false) return undefined;
  if (raw === true) {
    console.error(
      'The --keurmeester flag needs a value: --keurmeester <provider[/model]>, e.g. --keurmeester anthropic or --keurmeester openai/gpt-test.',
    );
    process.exit(2);
  }
  const value = String(raw).trim();
  if (value.length === 0) return undefined;
  const slash = value.indexOf('/');
  const providerName = slash === -1 ? value : value.slice(0, slash);
  const model = slash === -1 ? undefined : value.slice(slash + 1).trim();
  if (!isChatProvider(providerName)) {
    console.error(
      `Unknown --keurmeester provider "${providerName}". Expected one of: ${CHAT_PROVIDERS.join(', ')}.`,
    );
    process.exit(2);
  }
  if (isLocalEngine(providerName)) {
    console.error(
      `--keurmeester ${providerName} is a local engine — the supervisor must run on a non-local provider so it never queues behind the stuck local slot.`,
    );
    process.exit(2);
  }
  return { providerName, ...(model ? { model } : {}) };
}

export function printScenarios(scenarios: EvalScenario[]): void {
  console.log('Available scenarios:');
  for (const s of scenarios) {
    console.log(`  ${s.id.padEnd(20)} ${s.description}`);
  }
}

/**
 * Resolve the chat-provider flag from a parsed CLI argv. Accepts
 * `--provider <name>` (preferred) or the legacy `--engine <name>`,
 * tolerating either spelling for back-compat with CI scripts. Returns
 * `undefined` when neither flag is set so the runner can default to
 * `llama-cpp` itself.
 *
 * Validates against the `CHAT_PROVIDERS` allowlist and exits the
 * process with a clear error message on a typo — the trial would
 * otherwise spend minutes warming a non-existent engine before
 * surfacing the mistake.
 */
export function resolveProviderFlag(
  flags: Record<string, string | boolean>,
): ChatProvider | undefined {
  const raw = flags.provider ?? flags.engine;
  if (raw === undefined || raw === true || raw === false) return undefined;
  const value = String(raw).trim();
  if (value.length === 0) return undefined;
  if (!isChatProvider(value)) {
    console.error(`Unknown --provider "${value}". Expected one of: ${CHAT_PROVIDERS.join(', ')}.`);
    process.exit(2);
  }
  return value;
}
