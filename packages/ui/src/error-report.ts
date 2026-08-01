import type { ChatTurnErrorDetail, SystemDiagnostics } from '@bendyline/gezel';
import { redactSensitive } from '@bendyline/gezel';
import { ISSUES_NEW_URL } from './github-urls.js';

/**
 * Composes the text behind "Report error on GitHub…".
 *
 * Two rules govern everything here:
 *
 *   1. **Nothing identifying leaves the machine.** The composed body runs
 *      through one `redactSensitive` pass at the end — one choke point, so a
 *      section added later cannot forget to scrub, and one test covers every
 *      section at once. Error strings and stack traces are full of absolute
 *      paths, and every absolute path embeds the OS username.
 *   2. **The user is the last gate.** The dialog shows exactly this text and
 *      lets them edit it. Nothing is sent that they have not seen.
 */

export type ErrorReportSurface =
  | 'chat-turn'
  | 'session-error'
  | 'tab-crash'
  | 'settings-about'
  | 'install-health'
  | 'model-download';

export interface ErrorReportInput {
  surface: ErrorReportSurface;
  /** Empty for the Settings entry point, which is a blank problem report. */
  message: string;
  detail?: ChatTurnErrorDetail | undefined;
  stack?: string | undefined;
  componentStack?: string | undefined;
  diagnostics?: SystemDiagnostics | null | undefined;
}

const SURFACE_LABEL: Record<ErrorReportSurface, string> = {
  'chat-turn': 'chat turn failed',
  'session-error': 'chat turn failed',
  'tab-crash': 'tab crashed',
  'settings-about': 'problem report',
  'install-health': 'install health problem',
  'model-download': 'model download failed',
};

const PROMPT_HEADING = '### What I was doing';
const STACK_MAX = 2000;

function gb(bytes: number | null | undefined): string | null {
  if (bytes == null || bytes <= 0) return null;
  return `${Math.round(bytes / 1_000_000_000)} GB`;
}

function fence(body: string, lang = ''): string {
  return `\`\`\`${lang}\n${body}\n\`\`\``;
}

function machineLines(d: SystemDiagnostics): string[] {
  const lines = [`app: ${d.version}`, `node: ${d.runtime.nodeVersion}`];
  lines.push(
    `platform: ${d.runtime.platform} ${d.runtime.arch}` +
      `${d.runtime.platformKey ? ` (${d.runtime.platformKey})` : ''} ${d.runtime.osRelease}`,
  );

  const ram = gb(d.hardware.totalRamBytes);
  const vram = gb(d.hardware.gpuVramBytes);
  const memory = [ram ? `${ram} RAM` : null, vram ? `${vram} VRAM` : null]
    .filter(Boolean)
    .join(', ');
  if (memory) {
    lines.push(`memory: ${memory}${d.hardware.gpuVendor ? ` (${d.hardware.gpuVendor})` : ''}`);
  }
  if (d.hardware.gpuDevices.length > 0) {
    lines.push(
      `gpu: ${d.hardware.gpuDevices
        .map((g) => `${g.name}${g.driverVersion ? ` (driver ${g.driverVersion})` : ''}`)
        .join(', ')}`,
    );
  }

  const llama = [d.engine.llamaCppBackend, d.engine.llamaCppRevision].filter(Boolean).join(', ');
  if (llama) lines.push(`llama.cpp: ${llama}`);
  lines.push(`engines: ${d.engine.installedEngines.join(', ') || 'none installed'}`);
  if (d.models.installed.length > 0) {
    lines.push(
      `models: ${d.models.installed
        .map((m) => `${m.id} (${m.provider}${m.parameterSize ? `, ${m.parameterSize}` : ''})`)
        .join(', ')}`,
    );
  }
  lines.push(
    `default: ${d.models.defaultProvider}${d.models.defaultModel ? ` / ${d.models.defaultModel}` : ''}`,
  );
  return lines;
}

function detailLines(input: ErrorReportInput): string[] {
  const d = input.detail;
  const lines = [`surface: ${input.surface}`];
  if (d?.code) lines.push(`code: ${d.code}`);
  if (d?.engine) lines.push(`engine: ${d.engine}`);
  if (d?.incidentId) lines.push(`incident: ${d.incidentId}`);
  if (d?.panicKind) lines.push(`panic: ${d.panicKind}`);
  if (d?.signal) lines.push(`signal: ${d.signal}`);
  if (d?.exitCode != null) lines.push(`exit: ${d.exitCode}`);
  for (const [key, value] of Object.entries(d?.diagnostics ?? {})) {
    lines.push(`${key}: ${value}`);
  }
  return lines;
}

/**
 * Build the markdown that pre-fills the report textarea.
 *
 * Sections run most-valuable-first because URL truncation eats from the
 * bottom: the user's own words and the error itself always survive, and the
 * unbounded section (the stack) is last.
 */
export function formatErrorReport(input: ErrorReportInput): string {
  const blocks: string[] = [];

  blocks.push(
    `${PROMPT_HEADING}\n\n${
      input.message
        ? '<!-- One or two lines: what were you doing when this happened? -->'
        : '<!-- What went wrong? What were you doing? -->'
    }`,
  );

  if (input.message) blocks.push(`### Error\n\n${fence(input.message.trim(), 'text')}`);

  blocks.push(`### Details\n\n${fence(detailLines(input).join('\n'))}`);

  blocks.push(
    `### Machine\n\n${
      input.diagnostics
        ? fence(machineLines(input.diagnostics).join('\n'))
        : '_Machine profile unavailable — the diagnostics request failed._'
    }`,
  );

  const trace = [input.stack, input.componentStack].filter(Boolean).join('\n\n');
  if (trace) {
    const clipped =
      trace.length > STACK_MAX ? `${trace.slice(0, STACK_MAX)}\n… (truncated)` : trace;
    blocks.push(`### Stack\n\n${fence(clipped)}`);
  }

  blocks.push(
    '---\nReported from Gezel. I reviewed this text before sending; it contains no logs, ' +
      'file paths, or personal data.',
  );

  return redactSensitive(blocks.join('\n\n'));
}

/** Offset of the blank line under the first heading, so the caret lands there. */
export function reportCursorOffset(body: string): number {
  const heading = body.indexOf(PROMPT_HEADING);
  if (heading < 0) return 0;
  const gap = body.indexOf('\n\n', heading);
  return gap < 0 ? 0 : gap + 2;
}

const TITLE_MAX = 72;

/**
 * Run-specific numbers in a title mean two reports of the same crash never
 * collide in GitHub's duplicate search. A pid, an address, and a timestamp
 * carry no information the body does not already hold more precisely.
 */
const TITLE_NOISE: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b0x[0-9a-f]+\b/gi, '0x…'],
  [/\bpid[ =]\d+/gi, 'pid N'],
  [/\b\d+(?:\.\d+)?\s?(?:ms|s)\b/g, 'Nms'],
  // Word-boundary anchored, so an engine build tag like `b7021` survives
  // while an epoch-millis incident number does not.
  [/\b\d{4,}\b/g, 'N'],
];

export function deriveIssueTitle(input: ErrorReportInput): string {
  const scope = input.detail?.engine ?? input.detail?.code ?? SURFACE_LABEL[input.surface];

  let summary = redactSensitive(input.message)
    .split('\n')[0]
    // Gezel provider errors already open with a `[llama-cpp]`-style tag, and
    // the scope prefix below restates it. Drop it rather than double it.
    ?.replace(/^\[[^\]]{1,40}\]\s*/, '')
    .replace(/^\w*(?:Error|Exception):\s*/, '')
    .replace(/\s+/g, ' ')
    .replace(/[.;,\s]+$/, '')
    .trim();
  if (!summary) summary = SURFACE_LABEL[input.surface];
  for (const [pattern, replacement] of TITLE_NOISE) summary = summary.replace(pattern, replacement);
  const panic = input.detail?.panicKind;
  if (panic && !summary.includes(panic)) summary = `${summary} (${panic})`;

  const title = `[${scope}] ${summary}`;
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1).trimEnd()}…` : title;
}

export const DEFAULT_ISSUE_LABELS = ['bug'] as const;

/**
 * Windows routes `shell.openExternal` through ShellExecute, which refuses
 * URLs past roughly 2KB. GitHub itself accepts about 8KB, so only Windows
 * pays for the smaller budget.
 */
export const URL_BUDGET_WIN32 = 2000;
export const URL_BUDGET_DEFAULT = 8000;

const TRUNCATION_NOTE =
  '\n\n_This report was too long to fit in a link. The full text is on your clipboard — paste it here._';

export function buildIssueUrl(input: {
  title: string;
  body: string;
  labels?: readonly string[];
}): string {
  const labels = input.labels ?? DEFAULT_ISSUE_LABELS;
  // Hand-built rather than URLSearchParams, which encodes spaces as `+`.
  const params = [
    `title=${encodeURIComponent(input.title)}`,
    `body=${encodeURIComponent(input.body)}`,
  ];
  if (labels.length > 0) params.push(`labels=${encodeURIComponent(labels.join(','))}`);
  return `${ISSUES_NEW_URL}?${params.join('&')}`;
}

/**
 * The same URL, trimmed to fit the platform's budget by dropping whole lines
 * off the bottom. The head — what the user wrote, then the error — always
 * survives, so even a shortened issue is a usable issue.
 */
export function fitIssueUrl(input: {
  title: string;
  body: string;
  labels?: readonly string[];
  maxUrlLength?: number;
}): { url: string; truncated: boolean } {
  const max = input.maxUrlLength ?? URL_BUDGET_DEFAULT;
  const full = buildIssueUrl(input);
  if (full.length <= max) return { url: full, truncated: false };

  // encodeURIComponent maps each character independently, so a string's
  // encoded length is the sum of its pieces' encoded lengths — as long as a
  // split never lands inside a surrogate pair. Splitting on '\n' never does.
  const overhead = buildIssueUrl({ ...input, body: '' }).length;
  const budget = max - overhead - encodeURIComponent(TRUNCATION_NOTE).length;
  const kept: string[] = [];
  let used = 0;
  for (const line of input.body.split('\n')) {
    const cost = encodeURIComponent(`${line}\n`).length;
    if (used + cost > budget) break;
    kept.push(line);
    used += cost;
  }
  return {
    url: buildIssueUrl({ ...input, body: `${kept.join('\n')}${TRUNCATION_NOTE}` }),
    truncated: true,
  };
}
