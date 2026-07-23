import type { GezelClient } from '@bendyline/gezel-client/node';
import { extractInlineScripts, validateScriptSyntax } from '../html-validation.ts';
import { postMissingDeliverableFeedback, postSniffFeedback } from '../sniff-feedback.ts';
import type { SniffResult } from '../success-check.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';

/**
 * Redline-revision — requirements that change mid-flight.
 *
 * Axis: instruction stacking across turns. Nothing else in the suite
 * changes the requirements after kickoff; real users always do. A solo
 * seeded Developer builds a single-file habit tracker (phase 1), then
 * the harness — acting as the user — sends two staged revisions the
 * moment the previous phase's checks pass:
 *
 *   Revision 1: switch to a dark theme, keep everything else.
 *   Revision 2: remove the Add button (Enter key adds instead) and add
 *               a total-habits counter — and the kickoff's offline
 *               constraint still applies.
 *
 * One constraint ("must work entirely offline — no external network
 * requests of any kind, ever, including after future revisions") is
 * stated ONCE at kickoff and must survive all revisions. Small models
 * regress earlier constraints when applying deltas (the full-rewrite
 * habit); the final gate asserts the whole requirement stack at once.
 *
 * Grader notes:
 *   - `checkRedlinePhase` is pure (html + phase in, sniff out) and
 *     exported so the grader test can drive it without a daemon.
 *   - Every signal accepts multiple idioms (the style-blindness
 *     lesson — see fix-squisq's detectDeepValidation incident): dark
 *     theme via dark hex / rgb / hsl / prefers-color-scheme / a body
 *     dark class; Enter via key listeners, onkeydown attributes, key
 *     checks, or the form-submit idiom; the add button via label, id,
 *     class, or input[type=button|submit] value.
 *   - "No external refs" is a static property, so a static scan is the
 *     behavioral check here: `<script src=http…>`, `<link href=http…>`,
 *     `fetch(http…)`, `@import url(http…)` — with www.w3.org allowed
 *     as doctype/xmlns noise.
 */

const PROJECT_NAME = 'Habit Tracker Utility';
const DEVELOPER_NAME = 'Robin';
const TRACKER_PATH = 'tracker.html';

export type RedlinePhase = 1 | 2 | 3;

// ─────────────────────────────────────────────────────────────────────
// User-shaped texts. Exported so `evidenceTexts` and the setup hook
// can't drift apart (grader-lint cleanup #3): every REQUIRED signal is
// satisfiable from the kickoff + revision messages below.

export const REDLINE_MISSION_OBJECTIVES = [
  '1. Build a single self-contained habit tracker page at tracker.html (workspace root):',
  'a visible "Habit Tracker" title, a text input plus an Add button, a list of added',
  'habits, and inline JavaScript that renders each added habit into the list.',
  '2. PERSISTENT CONSTRAINT: the page must work entirely offline — no external network',
  'requests of any kind (no CDN scripts, no fetch to remote URLs, no external',
  'fonts/links), ever, including after future revisions.',
  '3. The user will send follow-up revision requests in chat; apply each one without',
  'regressing any earlier requirement.',
].join(' ');

export const REDLINE_KICKOFF_MESSAGE = [
  'Please build a small habit tracker as ONE single self-contained file at',
  '`tracker.html` (path relative to the workspace root — NOT `workspace/tracker.html`).',
  'Requirements: a visible "Habit Tracker" title; a text <input> plus an Add button;',
  'a list of the habits added so far; and inline JavaScript (a <script> block inside',
  'the same file) that reads the input and renders each added habit into the list.',
  'Plain HTML + inline <style> + inline <script> only — no build step.',
  'ONE PERSISTENT CONSTRAINT — keep it in mind for as long as this project lives:',
  'the page must work entirely OFFLINE — no external network requests of any kind',
  '(no CDN <script src>, no fetch() to remote URLs, no external fonts or remote',
  '<link href> stylesheets, no @import of remote CSS), ever, including after any',
  'future revisions I ask for. Write the complete tracker.html now; I will review',
  'it and may send revisions.',
].join(' ');

export const REDLINE_REVISION_1_MESSAGE = [
  'Revision 1 for `tracker.html`: switch the page to a dark theme (dark background,',
  'light text) — keep everything else exactly as it is. Patch the existing file; do',
  'not drop any current element or behavior.',
].join(' ');

export const REDLINE_REVISION_2_MESSAGE = [
  'Revision 2 for `tracker.html`: remove the Add button — adding a habit should',
  'happen on the Enter key instead (pressing Enter in the input adds the habit).',
  'Also add a counter element showing the total number of habits. And remember:',
  'the offline constraint from the original brief still applies — no external',
  'network requests of any kind.',
].join(' ');

// ─────────────────────────────────────────────────────────────────────
// Pure detectors. Each accepts every reasonable idiom for its signal.

function stripHtmlComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Scan for external references — the offline constraint is a static
 * property, so the static scan IS the behavioral check. Returns the
 * offending matches (label → URL) so feedback can name them verbatim.
 * www.w3.org is allowed (doctype/xmlns noise).
 */
export function detectExternalReferences(html: string): string[] {
  const visible = stripHtmlComments(html);
  const offenders: string[] = [];
  const patterns: Array<[string, RegExp]> = [
    ['<script src>', /<script\b[^>]*\bsrc\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi],
    ['<link href>', /<link\b[^>]*\bhref\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi],
    ['fetch()', /fetch\s*\(\s*[`'"](https?:\/\/[^`'"\s]+)/gi],
    ['@import', /@import\s+(?:url\s*\(\s*)?["']?(https?:\/\/[^"')\s]+)/gi],
  ];
  for (const [label, re] of patterns) {
    for (const m of visible.matchAll(re)) {
      const url = m[1] ?? '';
      if (/www\.w3\.org/i.test(url)) continue;
      offenders.push(`${label} → ${url}`);
    }
  }
  return offenders;
}

/** An "Add" button by label, id/class/name/aria-label, or input[type=button|submit] value. */
export function detectAddButton(html: string): boolean {
  const visible = stripHtmlComments(html);
  if (/<button\b[^>]*>(?:(?!<\/button>)[\s\S]){0,80}?\badd\b/i.test(visible)) return true;
  if (/<button\b[^>]*\b(?:id|class|name|aria-label)\s*=\s*["'][^"']*\badd/i.test(visible)) {
    return true;
  }
  if (
    /<input\b[^>]*\btype\s*=\s*["'](?:button|submit)["'][^>]*\bvalue\s*=\s*["'][^"']*\badd/i.test(
      visible,
    )
  ) {
    return true;
  }
  if (
    /<input\b[^>]*\bvalue\s*=\s*["'][^"']*\badd[^"']*["'][^>]*\btype\s*=\s*["'](?:button|submit)/i.test(
      visible,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Enter-key handling: key event listeners (addEventListener or on*
 * attributes/properties), explicit key/keyCode checks, or the
 * form-submit idiom (pressing Enter in a form input fires submit).
 */
export function detectEnterKeyHandling(html: string): boolean {
  const visible = stripHtmlComments(html);
  if (/addEventListener\s*\(\s*['"](?:keydown|keypress|keyup)['"]/i.test(visible)) return true;
  if (/\bon(?:keydown|keypress|keyup)\s*=/i.test(visible)) return true;
  if (/\bkey(?:Code)?\s*===?\s*(?:13\b|['"]Enter['"])/i.test(visible)) return true;
  if (/addEventListener\s*\(\s*['"]submit['"]/i.test(visible)) return true;
  if (/<form\b[^>]*\bonsubmit\s*=/i.test(visible)) return true;
  return false;
}

const DARK_VALUE_SRC = [
  // dark hex: each channel's leading nibble ≤ 3 (e.g. #111, #121212, #0d1117)
  String.raw`#(?:[0-3][0-9a-f][0-3][0-9a-f][0-3][0-9a-f]|[0-3]{3})\b`,
  String.raw`black\b`,
  // rgb()/rgba() with all channels ≤ 99 (comma or space syntax)
  String.raw`rgba?\(\s*\d{1,2}\s*[,\s]\s*\d{1,2}\s*[,\s]\s*\d{1,2}\b`,
  // hsl()/hsla() with lightness ≤ 35%
  String.raw`hsla?\([^)]{0,40}[,\s](?:[0-2]?\d(?:\.\d+)?|3[0-5])%\s*[),/]`,
].join('|');

const DARK_BG_RE = new RegExp(
  String.raw`(?:background(?:-color)?|--[\w-]*(?:bg|background|surface|base)[\w-]*)\s*:\s*(?:${DARK_VALUE_SRC})`,
  'i',
);

/**
 * Dark-theme evidence, idiom-agnostic: a dark background value on a
 * background property or a bg-ish custom property, a
 * prefers-color-scheme/color-scheme dark block, or a dark class on
 * body (markup or classList toggle).
 */
export function detectDarkTheme(html: string): boolean {
  const visible = stripHtmlComments(html);
  if (/prefers-color-scheme\s*:\s*dark/i.test(visible)) return true;
  if (/color-scheme\s*:\s*dark/i.test(visible)) return true;
  if (/<body\b[^>]*\bclass\s*=\s*["'][^"']*\bdark/i.test(visible)) return true;
  if (/classList\s*\.\s*add\s*\(\s*['"][^'"]*dark/i.test(visible)) return true;
  return DARK_BG_RE.test(visible);
}

/** A counter element (count/total id, class, or visible "total" text) updated from JS. */
export function detectCounter(html: string): boolean {
  const visible = stripHtmlComments(html);
  const counterElement =
    /\b(?:id|class)\s*=\s*["'][^"']*(?:count|total)/i.test(visible) ||
    /getElementById\s*\(\s*['"][^'"]*(?:count|total)/i.test(visible) ||
    /querySelector(?:All)?\s*\(\s*['"][^'"]*(?:count|total)/i.test(visible) ||
    /\btotal\b[^<>{}]{0,40}\bhabits?\b|\bhabits?\b[^<>{}]{0,40}\btotal\b/i.test(visible);
  if (!counterElement) return false;
  return /\.(?:textContent|innerText|innerHTML)\s*=/.test(visible) || /\.length\b/.test(visible);
}

function detectRenderJs(html: string): boolean {
  const scripts = extractInlineScripts(html)
    .map((s) => s.body)
    .join('\n');
  if (scripts.trim().length === 0) return false;
  const rendersDom =
    /\b(?:appendChild|insertAdjacentHTML|createElement|append)\s*\(/.test(scripts) ||
    /\.(?:innerHTML|textContent|innerText)\s*[+]?=/.test(scripts);
  const readsInput = /\.value\b/.test(scripts);
  return rendersDom && readsInput;
}

const PHASE1_REQUIRED = [
  'title',
  'input-field',
  'add-mechanism',
  'habit-list',
  'render-js',
  'js-parses',
  'offline-no-external-refs',
] as const;
const PHASE2_REQUIRED = [...PHASE1_REQUIRED, 'dark-theme'] as const;
const PHASE3_REQUIRED = [
  ...PHASE2_REQUIRED,
  'enter-key',
  'habit-counter',
  'add-button-removed',
] as const;

export function requiredSignalsForPhase(phase: RedlinePhase): readonly string[] {
  return phase === 1 ? PHASE1_REQUIRED : phase === 2 ? PHASE2_REQUIRED : PHASE3_REQUIRED;
}

/**
 * Pure phase check: html + phase in, sniff out. Phase 2 = phase-1 core
 * still passing + dark theme. Phase 3 = the full requirement stack:
 * core (minus the removed button) + dark + Enter-key + counter + the
 * kickoff's offline constraint. The phase-1 "add-mechanism" signal
 * accepts a button OR Enter handling so the final (button-less) page
 * still satisfies every phase's core.
 */
export function checkRedlinePhase(html: string, phase: RedlinePhase): SniffResult {
  const signals: string[] = [];
  const failures: string[] = [];
  const visible = stripHtmlComments(html);

  if (/habit\s*tracker/i.test(visible)) signals.push('title');
  else failures.push('no "Habit Tracker" title text found in the page');

  if (/<input\b/i.test(visible)) signals.push('input-field');
  else failures.push('no <input> element for entering a habit');

  const hasButton = detectAddButton(html);
  const hasEnter = detectEnterKeyHandling(html);
  if (hasButton || hasEnter) signals.push('add-mechanism');
  else failures.push('no way to add a habit (no Add button and no key/submit handler)');

  if (
    /<(?:ul|ol)\b/i.test(visible) ||
    /\b(?:id|class)\s*=\s*["'][^"']*(?:list|habits)/i.test(visible) ||
    /createElement\s*\(\s*['"]li['"]/i.test(visible)
  ) {
    signals.push('habit-list');
  } else {
    failures.push('no list element (ul/ol or a list/habits container) for the added habits');
  }

  if (detectRenderJs(html)) signals.push('render-js');
  else {
    failures.push(
      'inline JS does not read the input value and render habits into the DOM ' +
        '(need .value plus appendChild/innerHTML/textContent/createElement)',
    );
  }

  const scriptValidation = validateScriptSyntax(extractInlineScripts(html));
  if (scriptValidation.totalBytes > 0 && scriptValidation.allParse) signals.push('js-parses');
  else if (scriptValidation.totalBytes === 0) failures.push('no inline <script> JavaScript found');
  else failures.push(`inline JS does not parse: ${scriptValidation.firstError}`);

  const offenders = detectExternalReferences(html);
  if (offenders.length === 0) signals.push('offline-no-external-refs');
  else {
    failures.push(
      `external reference violates the offline constraint from the original brief: ${offenders[0]} — the page must work entirely offline (no CDN scripts, remote fetches, external fonts/styles)`,
    );
  }

  if (phase >= 2) {
    if (detectDarkTheme(html)) signals.push('dark-theme');
    else {
      failures.push(
        'no dark-theme evidence (need a dark background color in CSS — e.g. background: #121212 — ' +
          'or a prefers-color-scheme: dark block, or a dark class on body)',
      );
    }
  }

  if (phase >= 3) {
    if (hasEnter) signals.push('enter-key');
    else {
      failures.push(
        'no Enter-key handling (need a keydown/keypress listener, an onkeydown attribute, ' +
          "an e.key === 'Enter' check, or a form submit handler)",
      );
    }
    if (detectCounter(html)) signals.push('habit-counter');
    else {
      failures.push(
        'no counter element showing the total number of habits (an element with a count/total ' +
          'id or class, updated from the JS)',
      );
    }
    if (!hasButton) signals.push('add-button-removed');
    else {
      failures.push(
        'the Add button is still present — revision 2 asked to remove it (adding happens on Enter instead)',
      );
    }
  }

  const required = requiredSignalsForPhase(phase);
  const missing = required.filter((s) => !signals.includes(s));
  return {
    ok: missing.length === 0,
    signals,
    score: signals.length,
    ...(failures.length > 0 ? { failReason: failures[0] } : {}),
    ...(missing.length > 0 ? { missingRequiredSignals: missing } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Daemon-facing plumbing.

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

async function resolveDeveloperId(client: GezelClient): Promise<string | null> {
  const { gezels } = await client.listGezels();
  return gezels.find((g) => g.name === DEVELOPER_NAME)?.id ?? null;
}

async function setup({ client, log }: EvalContext): Promise<void> {
  let projectId = await findProjectId(client);
  if (!projectId) {
    const created = await client.createProject({
      name: PROJECT_NAME,
      about:
        'A small single-file habit tracker page, built and revised for a user whose ' +
        'requirements change mid-flight. The one permanent constraint: the page must work ' +
        'entirely offline — no external network requests of any kind, ever, including ' +
        'after future revisions the user asks for.',
      missionObjectives: REDLINE_MISSION_OBJECTIVES,
    });
    projectId = created.id;
    log(`[scenario:setup] created project name="${PROJECT_NAME}" id=${projectId}`);
  } else {
    log(`[scenario:setup] reusing existing project id=${projectId}`);
  }
  if (!projectId) throw new Error('redline-revision setup: failed to resolve project id');

  let dev: { id: string };
  try {
    // No hand-written about: the service resolves the shipped Developer
    // template (product-shaped prompt). Task specifics live in the
    // kickoff message — the eval measures the product configuration,
    // not a scenario-tuned system prompt.
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
    message: REDLINE_KICKOFF_MESSAGE,
    projectId,
  });
  log(`[scenario:setup] sent kickoff to ${DEVELOPER_NAME} in project ${projectId}`);
}

interface RedlineState {
  phase: RedlinePhase;
  /** Epoch ms of the last revision send; 0 before any revision. */
  sentAt: number;
  devId: string | null;
}

const stateByCtx = new WeakMap<EvalContext, RedlineState>();

/**
 * Grace window after sending a revision before sniff-failure nudges
 * resume — the worker JUST received the new requirement; nudging it
 * about the (expected) gap on the very next poll is noise.
 */
const REVISION_GRACE_MS = 3 * 60_000;

export const redlineRevisionScenario: EvalScenario = {
  id: 'redline-revision',
  description:
    'Staged requirement changes: build a single-file habit tracker, then absorb two mid-flight revisions (dark theme; remove the Add button → Enter key + counter) without regressing the kickoff\'s persistent "no external network requests" constraint.',
  prompt: [
    `Heads up: ${DEVELOPER_NAME} is building a small habit tracker page in the "${PROJECT_NAME}"`,
    'project and the user will send revision requests as the work lands. You do not need to do',
    "anything — just confirm you've seen this note.",
  ].join(' '),
  requiredPromptEvidence: [
    { signal: 'title', pattern: /habit tracker/ },
    { signal: 'offline-no-external-refs', pattern: /offline/ },
    { signal: 'dark-theme', pattern: /dark (?:theme|background)/ },
    { signal: 'enter-key', pattern: /enter key/ },
    { signal: 'habit-counter', pattern: /counter/ },
  ],
  evidenceTexts: [
    REDLINE_MISSION_OBJECTIVES,
    REDLINE_KICKOFF_MESSAGE,
    REDLINE_REVISION_1_MESSAGE,
    REDLINE_REVISION_2_MESSAGE,
  ],
  timeoutMs: 30 * 60_000,
  progressTimeoutMs: 15 * 60_000,
  setup,
  skipInitialPrompt: true,
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const { client, log, logChanged, recordSniff } = ctx;
    const projectId = await findProjectId(client);
    if (!projectId) {
      logChanged('project', '[scenario] habit-tracker project not present yet');
      return { done: false };
    }

    let state = stateByCtx.get(ctx);
    if (!state) {
      state = { phase: 1, sentAt: 0, devId: null };
      stateByCtx.set(ctx, state);
    }

    const html = await readWorkspaceText(client, projectId, TRACKER_PATH);
    if (html === null) {
      logChanged('sniff', '[scenario] tracker.html not present yet');
      recordSniff?.({ key: 'redline-revision', score: 0, bytes: 0 });
      await postMissingDeliverableFeedback(ctx, TRACKER_PATH, {
        minPolls: 18,
        repeatEvery: 18,
        maxNudges: 2,
        projectId,
      });
      return { done: false };
    }

    const check = checkRedlinePhase(html, state.phase);
    // Phase advances bump the recorded score past any single phase's max
    // so the runner's progress fingerprint sees revisions as movement.
    const score = (state.phase - 1) * 20 + check.score;
    logChanged(
      'sniff',
      `[scenario] redline-revision phase=${state.phase} bytes=${html.length} score=${check.score}/${requiredSignalsForPhase(state.phase).length} signals=${check.signals.join(',') || 'none'}${check.failReason ? ` failReason="${check.failReason}"` : ''}`,
    );
    recordSniff?.({ key: 'redline-revision', score, bytes: html.length });

    if (check.ok) {
      if (state.phase === 3) {
        return {
          done: true,
          success: true,
          reason: `full requirement stack holds after both revisions (signals: ${check.signals.join(', ')})`,
        };
      }
      if (!state.devId) state.devId = await resolveDeveloperId(client);
      if (!state.devId) {
        log('[scenario] phase passed but developer not found yet — retrying next poll');
        return { done: false };
      }
      const nextPhase = (state.phase + 1) as RedlinePhase;
      const revision = nextPhase === 2 ? REDLINE_REVISION_1_MESSAGE : REDLINE_REVISION_2_MESSAGE;
      try {
        await client.sendChatMessage(state.devId, { message: revision, projectId });
        log(
          `[scenario] phase ${state.phase} passed — sent revision ${nextPhase - 1}, now grading phase ${nextPhase}`,
        );
        state.phase = nextPhase;
        state.sentAt = Date.now();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[scenario] failed to send revision ${nextPhase - 1}: ${msg} — retrying next poll`);
      }
      return { done: false };
    }

    if (check.failReason) {
      const inGrace = state.sentAt > 0 && Date.now() - state.sentAt < REVISION_GRACE_MS;
      if (!inGrace) {
        await postSniffFeedback(ctx, TRACKER_PATH, check, {
          projectId,
          sourceText: html,
          dedupeToken: `phase-${state.phase}`,
        });
      }
    }
    return { done: false };
  },
};
