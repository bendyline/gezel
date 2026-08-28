/**
 * Optional LLM-as-judge layer.
 *
 * Static sniffs catch class-of-failure (no script tag, parse error,
 * missing image asset). Runtime assertions catch "doesn't actually
 * run." Neither tells you "this is an *ugly* tic-tac-toe" or "the copy
 * is amateurish." Those are qualitative axes a cheap cloud model can
 * answer in one call, given the original prompt + the final artifact +
 * a fixed rubric.
 *
 * Critical constraint: this is **advisory**. The composite score in
 * the skill rubric stays anchored to observable facts (Tier 1). The
 * judge's output lives in a parallel "qualitative" section of the
 * postmortem so a reader can see how the cloud model perceives the
 * artifact *without* the headline number drifting toward the judge's
 * opinion.
 *
 * Gated behind `--llm-judge` (CLI) or `evals: { llmJudge: true }`.
 * Skipped silently when no API key is configured.
 *
 * Frozen rubric (don't tune per-scenario — same rubric, same words,
 * always):
 *
 *   1. Visual quality        (0-10) — looks like a real product?
 *   2. Functional completeness (0-10) — meets the user's stated brief?
 *   3. Code quality          (0-10) — would a developer be embarrassed?
 *   4. Polish                (0-10) — surprising/delightful touches?
 *
 * Judge model: Claude Haiku 4.5 — cheap, fast, capable enough to
 * read 20 KB of HTML and emit structured JSON. Fall back to GPT-5
 * mini if ANTHROPIC_API_KEY is absent. If neither, return null.
 */

/**
 * Score axes — keyed by axis name. The existing HTML scenarios
 * (tictactoe, petshop, tankcombat) use the 4-axis default
 * (visualQuality / functionalCompleteness / codeQuality / polish);
 * new non-HTML scenarios (schema-migration, bookstore-openapi,
 * incident-postmortem) can override via `axisOverrides` and produce
 * scenario-specific keys (e.g. `factualAccuracy`, `apiDesignQuality`).
 *
 * Keeping this as a flat `Record<string, number>` so score-trial.ts +
 * postmortem authors can `.scoreAxes.<name>` either shape.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

export type JudgeScoreAxes = Record<string, number>;

export interface JudgeReport {
  /** Which model + provider did the judging — keep for audit. */
  judgeModel: string;
  judgeProvider: 'anthropic' | 'openai' | 'anthropic-cli';
  scenarioId: string;
  scoreAxes: JudgeScoreAxes;
  /** Mean of the axes. Provided so the skill can drop a single line in the report. */
  meanScore: number;
  /** Free-form justification from the judge, ≤ 500 chars. */
  justification: string;
  /** What the judge was actually sent — useful for postmortem reproducibility. */
  promptTokens?: number;
  completionTokens?: number;
  /** Wall-clock for the judge call. */
  durationMs: number;
}

/**
 * Default 4-axis HTML rubric — used by tictactoe / petshop / tankcombat
 * via the back-compat code path (no `axisOverrides` supplied).
 */
const DEFAULT_HTML_AXES: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'visualQuality', description: 'Does it look like a real product, or a debug page?' },
  {
    name: 'functionalCompleteness',
    description: "Does it implement the user's stated brief?",
  },
  {
    name: 'codeQuality',
    description: 'Would a developer reading the source be embarrassed?',
  },
  { name: 'polish', description: 'Are there surprising / delightful touches?' },
];

function buildRubric(axes: ReadonlyArray<{ name: string; description: string }>): string {
  const numberedList = axes
    .map((axis, idx) => `  ${idx + 1}. ${axis.name.padEnd(24)} — ${axis.description}`)
    .join('\n');
  const schemaLines = axes.map((axis) => `    "${axis.name}": <int 0-10>`).join(',\n');
  return `You are reviewing an artifact produced by an AI agent for a user.
You will rate it on ${axes.length} fixed axes (0-10 each) and provide a short
justification. Be honest and specific. Tend toward 5 for "delivered the
brief at all" and reserve 9-10 for genuinely polished work.

AXES (each 0-10, integer):
${numberedList}

Return STRICTLY valid JSON matching this schema; no markdown fences,
no prefix, no commentary outside the JSON:

  {
${schemaLines},
    "justification": "<one paragraph, ≤ 400 chars, specific>"
  }
`;
}

/** Map artifactKind → fenced code-block language hint for the judge prompt. */
const ARTIFACT_FENCE_LANG: Record<NonNullable<RunLlmJudgeOpts['artifactKind']>, string> = {
  html: 'html',
  markdown: 'markdown',
  yaml: 'yaml',
  typescript: 'typescript',
  json: 'json',
  text: 'text',
};

const ANTHROPIC_MODEL = 'claude-haiku-4-5';
/**
 * Model id for the CLI backend. Dashed, not dotted — the Claude CLI
 * rejects `claude-sonnet-4.6` and the mistake is silent until the call
 * fails (wild-caught during the anthropic-cli provider bring-up).
 */
const CLI_MODEL = 'claude-sonnet-4-6';
const OPENAI_MODEL = 'gpt-5-mini';

export interface RunLlmJudgeOpts {
  scenarioId: string;
  /** Prompt that was originally sent to the Meester. */
  userPrompt: string;
  /** Final artifact to judge — HTML for the legacy trio, Markdown / YAML / TS for newer scenarios. */
  artifact: string;
  /** Per-scenario brief; combined with the rubric so the judge knows what to weigh. */
  scenarioBrief: string;
  /**
   * What kind of artifact is being judged. Controls the fenced
   * code-block language hint in the prompt. Defaults to `'html'` so
   * existing tictactoe / petshop / tankcombat callers don't need to
   * change anything.
   */
  artifactKind?: 'html' | 'markdown' | 'yaml' | 'typescript' | 'json' | 'text';
  /**
   * Override the rubric's axes. When set, replaces the default 4 HTML
   * axes (visualQuality / functionalCompleteness / codeQuality / polish)
   * with the supplied list. Each entry's `name` becomes a key on
   * `JudgeReport.scoreAxes`; `description` is shown to the judge to
   * anchor what the axis means.
   *
   * Use for scenarios where the HTML axes don't fit — e.g.
   * incident-postmortem asks for `factualAccuracy` /
   * `structureSoundness` / `actionability` / `tone`.
   */
  axisOverrides?: ReadonlyArray<{ name: string; description: string }>;
  /**
   * Extra context to inject into the judge prompt — typically a
   * summary of the fixture / evidence pack the model was supposed to
   * work from. The incident-postmortem scenario uses this so the
   * judge can spot invented facts in the produced postmortem without
   * having to read the entire 10 KB evidence pack itself.
   *
   * Optional; left out of the prompt when unset.
   */
  judgeContextNote?: string;
  log: (line: string) => void;
}

export async function runLlmJudge(opts: RunLlmJudgeOpts): Promise<JudgeReport | null> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  // Third backend: the locally-authenticated Claude CLI. It needs no API
  // key (macOS keychain / subscription auth), which is the common case on
  // a developer machine — without it the judge silently no-ops and the
  // qualitative axes never get collected at all.
  const cliPath = !anthropicKey && !openaiKey ? resolveJudgeCli() : null;
  if (!anthropicKey && !openaiKey && !cliPath) {
    opts.log('[llm-judge] skipped: no ANTHROPIC_API_KEY, OPENAI_API_KEY, or claude CLI on PATH');
    return null;
  }

  // Keep the artifact bounded — the cloud cost scales with prompt tokens.
  // 20 KB is plenty for a single-page interactive HTML to feel
  // judgable. Larger artifacts get truncated with a banner the judge
  // can see, so it knows it's not seeing everything.
  const MAX_ARTIFACT_BYTES = 20 * 1024;
  const artifactClipped =
    opts.artifact.length > MAX_ARTIFACT_BYTES
      ? `${opts.artifact.slice(0, MAX_ARTIFACT_BYTES)}\n\n<!-- TRUNCATED: original was ${opts.artifact.length} bytes -->`
      : opts.artifact;

  const axes = opts.axisOverrides ?? DEFAULT_HTML_AXES;
  const rubric = buildRubric(axes);
  const artifactKind = opts.artifactKind ?? 'html';
  const fenceLang = ARTIFACT_FENCE_LANG[artifactKind];
  const contextSection = opts.judgeContextNote
    ? `\n\nFixture context (the model was working from these supplied artifacts):\n---\n${opts.judgeContextNote}\n---`
    : '';
  const userMessage = `${rubric}\n\nScenario: ${opts.scenarioId}\nBrief: ${opts.scenarioBrief}${contextSection}\n\nOriginal user prompt to the AI agent:\n---\n${opts.userPrompt}\n---\n\nFinal artifact (${artifactKind}):\n\`\`\`${fenceLang}\n${artifactClipped}\n\`\`\`\n\nReturn your JSON now.`;

  const startedAt = Date.now();
  try {
    const provider: JudgeReport['judgeProvider'] = anthropicKey
      ? 'anthropic'
      : openaiKey
        ? 'openai'
        : 'anthropic-cli';
    const result = anthropicKey
      ? await callAnthropic(anthropicKey, userMessage)
      : openaiKey
        ? await callOpenAI(openaiKey, userMessage)
        : await callClaudeCli(cliPath!, userMessage);
    const parsed = parseJudgeResponse(
      result.text,
      axes.map((a) => a.name),
    );
    if (!parsed) {
      opts.log(`[llm-judge] parse failed; raw response head: ${result.text.slice(0, 200)}`);
      return null;
    }
    const axisValues = Object.values(parsed.scoreAxes);
    const meanScore =
      axisValues.length > 0 ? axisValues.reduce((s, v) => s + v, 0) / axisValues.length : 0;
    const report: JudgeReport = {
      judgeProvider: provider,
      judgeModel:
        provider === 'anthropic'
          ? ANTHROPIC_MODEL
          : provider === 'openai'
            ? OPENAI_MODEL
            : CLI_MODEL,
      scenarioId: opts.scenarioId,
      scoreAxes: parsed.scoreAxes,
      meanScore: Math.round(meanScore * 10) / 10,
      justification: parsed.justification,
      durationMs: Date.now() - startedAt,
      ...(result.promptTokens !== undefined ? { promptTokens: result.promptTokens } : {}),
      ...(result.completionTokens !== undefined
        ? { completionTokens: result.completionTokens }
        : {}),
    };
    const axisSummary = axes
      .map((axis) => `${shortAxisLabel(axis.name)}=${report.scoreAxes[axis.name]}`)
      .join(' ');
    opts.log(
      `[llm-judge] ${report.judgeProvider}/${report.judgeModel} mean=${report.meanScore} (${axisSummary}) in ${report.durationMs}ms`,
    );
    return report;
  } catch (err) {
    opts.log(`[llm-judge] call failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Compact axis label for the one-line judge log — drops camelCase and
 * shortens to ≤ 4 chars so the log line stays scannable. `visualQuality`
 * → `vq`; `factualAccuracy` → `fa`. Falls back to the first 3 chars
 * when no camelCase split exists.
 */
function shortAxisLabel(name: string): string {
  const camelParts = name.match(/[A-Z]?[a-z]+/g) ?? [];
  if (camelParts.length >= 2) {
    return camelParts.map((p) => p[0]?.toLowerCase() ?? '').join('');
  }
  return name.slice(0, 3).toLowerCase();
}

interface RawJudgeResponse {
  text: string;
  promptTokens?: number;
  completionTokens?: number;
}

/**
 * Locate a usable Claude CLI.
 *
 * `GEZEL_JUDGE_CLI` overrides for operators with a non-standard install;
 * otherwise the first `claude` on PATH. Returns null when absent so the
 * caller can degrade rather than throw.
 */
export function resolveJudgeCli(): string | null {
  const override = process.env.GEZEL_JUDGE_CLI?.trim();
  if (override) return existsSync(override) ? override : null;
  // `which` does not exist on Windows — probing with it silently disabled
  // the CLI backend there, and the whole judge pass booked as "no
  // artifact" (wild-caught: the 2026-08-27 win32 sweep judged 0 of 308).
  // `where` lists every PATH match; only a native .exe is accepted because
  // spawnSync cannot launch a `.cmd` shim without a shell on current Node.
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const found = spawnSync(finder, ['claude'], { encoding: 'utf8' });
  if (found.status !== 0) return null;
  const lines = (found.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const path =
    process.platform === 'win32'
      ? (lines.find((line) => line.toLowerCase().endsWith('.exe')) ?? '')
      : (lines[0] ?? '');
  return path && existsSync(path) ? path : null;
}

/**
 * Judge through the locally-authenticated Claude CLI.
 *
 * Deliberately non-interactive and tool-less: `-p` prints one response
 * and exits, and the judge must reason ONLY from the prompt it is given.
 * A judge that could read the repository could look up the grader it is
 * being asked to second-guess, which would make its score a function of
 * the harness rather than of the artifact.
 *
 * Token counts are unavailable from the CLI, so they stay undefined —
 * better an absent number than an invented one.
 */
async function callClaudeCli(cliPath: string, prompt: string): Promise<RawJudgeResponse> {
  const result = spawnSync(cliPath, ['-p', prompt, '--model', CLI_MODEL], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
    // Inherit nothing that would let the CLI pick up repo context.
    cwd: tmpdir(),
  });
  if (result.error) throw new Error(`claude CLI failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `claude CLI exited ${result.status}: ${(result.stderr || result.stdout || '').slice(0, 200)}`,
    );
  }
  const text = (result.stdout ?? '').trim();
  if (!text) throw new Error('claude CLI returned no output');
  return { text };
}

async function callAnthropic(apiKey: string, prompt: string): Promise<RawJudgeResponse> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  // biome-ignore lint/suspicious/noExplicitAny: anthropic response shape
  const json: any = await res.json();
  const text = (json.content ?? [])
    // biome-ignore lint/suspicious/noExplicitAny: anthropic content block
    .filter((b: any) => b.type === 'text')
    // biome-ignore lint/suspicious/noExplicitAny: anthropic content block
    .map((b: any) => b.text ?? '')
    .join('');
  return {
    text,
    promptTokens: json.usage?.input_tokens,
    completionTokens: json.usage?.output_tokens,
  };
}

async function callOpenAI(apiKey: string, prompt: string): Promise<RawJudgeResponse> {
  // Uses the Responses API (modern OpenAI shape). Stored=false because
  // we don't want eval prompts polluting the user's session history.
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: prompt,
      store: false,
      max_output_tokens: 800,
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  // biome-ignore lint/suspicious/noExplicitAny: openai response shape
  const json: any = await res.json();
  // OpenAI Responses API: `output_text` is the convenience field; fall
  // back to walking `output[]` if it's missing.
  const text =
    typeof json.output_text === 'string'
      ? json.output_text
      : (json.output ?? [])
          // biome-ignore lint/suspicious/noExplicitAny: openai content path
          .flatMap((m: any) => m.content ?? [])
          // biome-ignore lint/suspicious/noExplicitAny: openai content path
          .map((c: any) => c.text ?? '')
          .join('');
  return {
    text,
    promptTokens: json.usage?.input_tokens,
    completionTokens: json.usage?.output_tokens,
  };
}

/**
 * Parse the judge's response. Tolerates: bare JSON, JSON in ```json
 * fences, JSON with surrounding prose. Returns null on any parse
 * failure so the caller can decide whether to log + skip vs retry.
 *
 * Requires every name in `expectedAxes` to appear as a numeric field
 * 0-10 in the parsed object, plus a `justification` string. Extra keys
 * are dropped silently — keeps the response forgiving when the judge
 * adds a stray field.
 */
function parseJudgeResponse(
  text: string,
  expectedAxes: readonly string[],
): { scoreAxes: JudgeScoreAxes; justification: string } | null {
  // Strip code fences if present.
  let body = text.trim();
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) body = fenced[1]?.trim() ?? '';
  // Find first '{' if there's prose preamble.
  const firstBrace = body.indexOf('{');
  if (firstBrace > 0) body = body.slice(firstBrace);
  // Find last '}' to drop trailing prose.
  const lastBrace = body.lastIndexOf('}');
  if (lastBrace !== -1) body = body.slice(0, lastBrace + 1);
  try {
    const obj = JSON.parse(body) as Record<string, unknown>;
    const just = typeof obj.justification === 'string' ? obj.justification : null;
    if (just === null) return null;
    const scoreAxes: JudgeScoreAxes = {};
    for (const axis of expectedAxes) {
      const raw = Number(obj[axis]);
      if (!Number.isFinite(raw) || raw < 0 || raw > 10) return null;
      scoreAxes[axis] = Math.round(raw);
    }
    return { scoreAxes, justification: just };
  } catch {
    return null;
  }
}
