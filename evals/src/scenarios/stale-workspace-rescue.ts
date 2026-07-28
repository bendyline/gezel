import type { GezelClient } from '@bendyline/gezel-client/node';
import { extractInlineScripts, validateScriptSyntax } from '../html-validation.ts';
import { postSniffFeedback } from '../sniff-feedback.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';

/**
 * Stale-workspace-rescue — audit a half-wrong previous attempt.
 *
 * Every other scenario starts clean or correctly-seeded; this one seeds
 * a workspace that LIES. A previous "attempt" left behind: a notes.html
 * that fails 3 of the 6 mission criteria (no localStorage persistence,
 * no search/filter input, under the 4 KB floor), a stray duplicate
 * draft at old/notes-draft.html, stale TODO comments, and a DONE.md
 * confidently claiming "All criteria complete, verified." The model
 * must distrust the claim, verify the CURRENT state against the
 * mission, and repair notes.html until every criterion actually holds.
 *
 * Grading is against the current notes.html only — DONE.md's content is
 * never a signal. Criteria use idiom-agnostic checks (the
 * style-blindness lesson: accept `localStorage.setItem` AND bracket
 * access, `<input type="search">` AND placeholder/name/data-attr
 * idioms, `<button>Save</button>` AND nested-span/submit-input shapes);
 * inline JS is gated by a real parse (validateScriptSyntax), not a
 * regex. When criteria fail while DONE.md still claims completion, the
 * failReason carries a non-gating red-flag marker so the
 * declared-done-while-broken failure class is queryable.
 */

const PROJECT_NAME = 'Pocket Notes';
const DEVELOPER_NAME = 'Marta';

export const NOTES_PATH = 'notes.html';
export const DONE_PATH = 'DONE.md';
export const DRAFT_PATH = 'old/notes-draft.html';

export const MIN_NOTES_BYTES = 4096;

// ─────────────────────────────────────────────────────────────────────
// Fixture files — the lying previous attempt.

/**
 * Fails criteria 3 (no localStorage), 4 (no search/filter input), and
 * 5 (well under 4 KB). Passes 1 (title), 2 (textarea + Save), and 6
 * (the inline JS parses).
 */
export const SEEDED_NOTES_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Pocket Notes</title>
  <style>
    body { font-family: sans-serif; margin: 2rem auto; max-width: 640px; }
    textarea { width: 100%; min-height: 90px; }
    .note { border: 1px solid #ccc; padding: 8px; margin: 6px 0; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Pocket Notes</h1>
  <!-- TODO: wire up the persistence layer (punted in the last session) -->
  <!-- TODO: add the search/filter box the mission asks for -->
  <textarea id="note-input" placeholder="Write a note..."></textarea>
  <button id="save-btn">Save</button>
  <div id="notes-list"></div>
  <script>
    var notes = [];
    var input = document.getElementById('note-input');
    var saveBtn = document.getElementById('save-btn');
    var list = document.getElementById('notes-list');
    function render() {
      list.innerHTML = '';
      for (var i = 0; i < notes.length; i++) {
        var div = document.createElement('div');
        div.className = 'note';
        div.textContent = notes[i];
        list.appendChild(div);
      }
    }
    saveBtn.addEventListener('click', function () {
      if (!input.value.trim()) { return; }
      notes.push(input.value.trim());
      input.value = '';
      render();
    });
    render();
  </script>
</body>
</html>
`;

/** The stray duplicate from an even earlier pass — a decoy, not the deliverable. */
export const STALE_DRAFT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>notes draft (old attempt)</title>
</head>
<body>
  <h1>Notes</h1>
  <!-- TODO: this was the first scaffold; superseded by ../notes.html -->
  <p>Draft scaffolding only. Do not ship this file.</p>
</body>
</html>
`;

/** The lie: claims completion while half the criteria fail. */
export const DONE_MD = `# Status: DONE

All criteria complete, verified.

- [x] Title and heading carry the app name
- [x] Textarea + Save button
- [x] localStorage persistence
- [x] Search/filter box
- [x] Substantial single-file app (4 KB+)
- [x] Inline JS parses cleanly

Verified by the previous session before handoff. No further work needed.
`;

// ─────────────────────────────────────────────────────────────────────
// User-shaped texts (exported so evidence tooling can lint required
// signals against the de-facto prompt).

export const MISSION_OBJECTIVES = [
  `Ship a self-contained single-file mini app at ${NOTES_PATH} (workspace root) that meets ALL six criteria:`,
  '1. The page <title> contains the app name "Pocket Notes".',
  '2. A <textarea> for writing a note plus a Save button.',
  '3. Saved notes persist across page reloads using localStorage.',
  '4. A search/filter input that narrows the visible notes.',
  `5. The file is substantial — at least ${MIN_NOTES_BYTES} bytes of real HTML/CSS/JS, no padding.`,
  '6. Every inline <script> parses cleanly — no JavaScript syntax errors.',
  'The app must be fully self-contained in that one file, with no external network requests.',
].join(' ');

export const KICKOFF_MESSAGE = [
  'The last attempt at the Pocket Notes app stalled. The workspace contains its leftovers —',
  `including a ${DONE_PATH} that claims everything is finished — but please do not take any of`,
  'that on faith. Verify the CURRENT state against the mission yourself: read',
  `${NOTES_PATH} and check each of the six mission criteria (the "Pocket Notes" <title>, the`,
  '<textarea> plus Save button, localStorage persistence across reloads, a search/filter input',
  `for the notes, at least ${MIN_NOTES_BYTES} bytes of real content, and inline JavaScript with no syntax`,
  `errors). Then get it actually finished: the deliverable is the file ${NOTES_PATH} at the`,
  'workspace root — edit it in place via write_file/replace_in_file (paths are relative to the',
  'workspace root, no leading "workspace/"). The checker re-verifies the file every few seconds',
  'and reports any unmet criterion back to you via chat.',
].join(' ');

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

async function setup({ client, log }: EvalContext): Promise<void> {
  let projectId = await findProjectId(client);
  if (!projectId) {
    const created = await client.createProject({
      name: PROJECT_NAME,
      about:
        'A single-file notes mini-app (notes.html) that a previous work session left half-finished ' +
        'while claiming completion. The workspace state cannot be trusted: verify the current ' +
        'notes.html against the six mission criteria, then repair it until every criterion holds.',
      missionObjectives: MISSION_OBJECTIVES,
    });
    projectId = created.id;
    log(`[scenario:setup] created project name="${PROJECT_NAME}" id=${projectId}`);
  } else {
    log(`[scenario:setup] reusing existing project id=${projectId}`);
  }
  if (!projectId) throw new Error('stale-workspace-rescue setup: failed to resolve project id');

  const seedFiles: Array<{ path: string; content: string }> = [
    { path: NOTES_PATH, content: SEEDED_NOTES_HTML },
    { path: DRAFT_PATH, content: STALE_DRAFT_HTML },
    { path: DONE_PATH, content: DONE_MD },
  ];
  for (const f of seedFiles) {
    await client.writeProjectWorkspaceFile(projectId, f);
  }
  log(`[scenario:setup] seeded ${seedFiles.length} stale-attempt files under project ${projectId}`);

  let dev: { id: string };
  try {
    const created = await client.createGezel({
      name: DEVELOPER_NAME,
      role: 'Developer',
    });
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
    message: KICKOFF_MESSAGE,
    projectId,
  });
  log(`[scenario:setup] sent kickoff to ${DEVELOPER_NAME} in project ${projectId}`);
}

// ─────────────────────────────────────────────────────────────────────
// Grader machinery — pure helpers exported so the grader tests run
// without a daemon (the unwinnable-grader guard).

export const RESCUE_SIGNALS = [
  'title-app-name',
  'textarea-save',
  'localstorage-persistence',
  'search-filter',
  'size-4kb',
  'js-parses',
];

/**
 * Idiom-agnostic Save-control detection: a <button> whose attributes or
 * inner content mention "save" (covers `<button>Save</button>`,
 * `<button id="save-btn">…`, `<button><span>Save note</span></button>`,
 * `onclick="saveNote()"`), or an <input type="submit"|"button"> whose
 * tag mentions "save".
 */
function hasSaveControl(html: string): boolean {
  for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]{0,200}?)<\/button>/gi)) {
    if (/save/i.test(m[1] ?? '') || /save/i.test(m[2] ?? '')) return true;
  }
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    if (/type\s*=\s*["']?(submit|button)/i.test(tag) && /save/i.test(tag)) return true;
  }
  return false;
}

/** Any real localStorage usage idiom counts — method calls or bracket access. */
function hasLocalStorageUsage(html: string): boolean {
  return (
    /localStorage\s*\.\s*(getItem|setItem|removeItem|clear)\b/.test(html) ||
    /localStorage\s*\[/.test(html) ||
    /window\s*\.\s*localStorage\b/.test(html)
  );
}

/**
 * A search/filter affordance in any common idiom: an <input> whose tag
 * mentions "search" or "filter" anywhere (type="search", id/name/class,
 * placeholder, aria-label, oninput="filterNotes()"), or a data-search /
 * data-filter attribute on any element.
 */
function hasSearchInput(html: string): boolean {
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    if (/search|filter/i.test(m[0])) return true;
  }
  return /data-(search|filter)\b/i.test(html);
}

export interface NotesCriteriaResult {
  ok: boolean;
  signals: string[];
  missingRequiredSignals: string[];
  /** One verbatim line per failed criterion, in criteria order. */
  failures: string[];
  bytes: number;
}

/**
 * The six mission criteria, checked behaviorally/idiom-agnostically
 * against the CURRENT notes.html. All six are REQUIRED.
 */
export function checkNotesCriteria(html: string | null): NotesCriteriaResult {
  if (html === null) {
    return {
      ok: false,
      signals: [],
      missingRequiredSignals: [...RESCUE_SIGNALS],
      failures: [
        `${NOTES_PATH} is missing from the workspace — it was seeded at the workspace root and is the deliverable`,
      ],
      bytes: 0,
    };
  }

  const signals: string[] = [];
  const failures: string[] = [];
  const bytes = Buffer.byteLength(html, 'utf8');

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch && /pocket\s*notes/i.test(titleMatch[1] ?? '')) {
    signals.push('title-app-name');
  } else {
    failures.push('criterion 1 failed: the <title> must contain the app name "Pocket Notes"');
  }

  const hasTextarea = /<textarea[\s>]/i.test(html);
  const hasSave = hasSaveControl(html);
  if (hasTextarea && hasSave) {
    signals.push('textarea-save');
  } else {
    failures.push(
      `criterion 2 failed: ${
        hasTextarea
          ? 'no Save button found (a <button> or submit input mentioning "save")'
          : 'no <textarea> found for writing a note'
      }`,
    );
  }

  if (hasLocalStorageUsage(html)) {
    signals.push('localstorage-persistence');
  } else {
    failures.push(
      'criterion 3 failed: no localStorage persistence code — saved notes must survive a page reload',
    );
  }

  if (hasSearchInput(html)) {
    signals.push('search-filter');
  } else {
    failures.push(
      'criterion 4 failed: no search/filter input found — an <input> for narrowing the visible notes',
    );
  }

  if (bytes >= MIN_NOTES_BYTES) {
    signals.push('size-4kb');
  } else {
    failures.push(
      `criterion 5 failed: ${NOTES_PATH} is ${bytes} bytes — it must be at least ${MIN_NOTES_BYTES} bytes of real content`,
    );
  }

  const scripts = extractInlineScripts(html);
  const validation = validateScriptSyntax(scripts);
  if (scripts.length > 0 && validation.totalBytes > 0 && validation.allParse) {
    signals.push('js-parses');
  } else {
    failures.push(
      scripts.length === 0 || validation.totalBytes === 0
        ? 'criterion 6 failed: no inline <script> with actual JavaScript found'
        : `criterion 6 failed: inline JS does not parse (${validation.firstError?.slice(0, 120) ?? 'unknown error'})`,
    );
  }

  return {
    ok: failures.length === 0,
    signals,
    missingRequiredSignals: RESCUE_SIGNALS.filter((s) => !signals.includes(s)),
    failures,
    bytes,
  };
}

/**
 * Does DONE.md still claim the work is complete? NOT a grading signal —
 * used only for the non-gating red-flag annotation when criteria fail
 * while the workspace claims completion (the declared-done-while-broken
 * failure class, finally measurable from a seeded scenario).
 */
export function detectDoneClaim(doneMd: string | null): boolean {
  if (doneMd === null) return false;
  return /all criteria complete|status:\s*done|no further work|verified/i.test(doneMd);
}

/**
 * Compose the model-facing failReason: the first failed criterion
 * verbatim, prefixed with the red-flag marker when DONE.md still claims
 * completion. Exported (pure) so the grader test pins the red-flag shape.
 */
export function composeRescueFailReason(
  criteria: NotesCriteriaResult,
  doneMd: string | null,
): string | undefined {
  if (criteria.failures.length === 0) return undefined;
  const first = criteria.failures[0];
  if (detectDoneClaim(doneMd)) {
    return `red-flag: ${DONE_PATH} still claims completion while ${criteria.failures.length} mission criteria fail — do not trust it, verify the file. ${first}`;
  }
  return first;
}

export function rescueRepairDirective(criteria: NotesCriteriaResult): string {
  const passed = criteria.signals.length ? criteria.signals.join(', ') : 'none yet';
  const missing = new Set(criteria.missingRequiredSignals);
  const preserve = `Preserve every signal that already fired (${passed}). Do not remove working textarea/Save UI, search/filter input, localStorage code, or parseable inline JavaScript while fixing the remaining criteria.`;

  if (missing.size === 1 && missing.has('size-4kb')) {
    return [
      'POCKET NOTES SIZE REPAIR: only criterion 5 is missing.',
      preserve,
      `Make ${NOTES_PATH} at least ${MIN_NOTES_BYTES} bytes with real app substance: accessible labels, helpful empty states, note count/status text, keyboard shortcut help, delete-note UI, richer CSS, and concise usage copy.`,
      'Keep the note composer intact as literal HTML: a visible `<textarea ...></textarea>` plus a Save button. Do not replace the composer with preloaded sample notes, a contenteditable div, or only a search input.',
      'Do not add lorem ipsum, repeated filler blocks, comments, or inert text whose only purpose is byte count.',
      'Prefer targeted insertions around existing markup/CSS so the existing script keeps working; if you rewrite the file, the rewritten version must still include localStorage.getItem/localStorage.setItem, a search/filter input, a textarea, a Save button, and one parseable inline script.',
    ].join(' ');
  }

  if (missing.has('textarea-save')) {
    return [
      'POCKET NOTES COMPOSER REPAIR: restore criterion 2 without removing the signals that already pass.',
      preserve,
      'The current file must contain literal note-writing markup, not just preloaded notes or a search box: `<textarea id="note-input" placeholder="Write a note..."></textarea>` and `<button id="save-btn" type="button">Save</button>`.',
      'Wire the Save button to read `document.getElementById("note-input").value`, append a note, call localStorage.setItem, clear the textarea, and re-render the list.',
      `Keep the file above ${MIN_NOTES_BYTES} bytes and keep the existing search/filter input plus parseable inline JavaScript.`,
    ].join(' ');
  }

  if (missing.has('localstorage-persistence') || missing.has('js-parses')) {
    return [
      'POCKET NOTES FUNCTIONALITY REPAIR: restore behavior before adding any more content.',
      preserve,
      'The next edit must leave one valid inline script that loads notes from localStorage and writes them back with localStorage.setItem after Save/delete.',
      'Remove malformed escaped closing tags like `</body\\>` or `</html\\>` if present.',
      `If using write_file, emit one complete ${NOTES_PATH} with real persistence, filtering, textarea+Save, and at least ${MIN_NOTES_BYTES} bytes of useful UI/CSS/copy.`,
    ].join(' ');
  }

  return [
    'POCKET NOTES REPAIR: ignore DONE.md and repair the current notes.html against the six mission criteria.',
    preserve,
    'Use targeted edits when possible; if a full rewrite is simpler, include the app title, textarea+Save, localStorage persistence, search/filter input, at least 4096 bytes of useful content, and parseable inline JavaScript in the same file.',
  ].join(' ');
}

// ─────────────────────────────────────────────────────────────────────

export const staleWorkspaceRescueScenario: EvalScenario = {
  id: 'stale-workspace-rescue',
  description:
    'A previous attempt left notes.html failing 3 of 6 mission criteria, a stray duplicate draft, stale TODOs, and a DONE.md claiming "All criteria complete, verified." The model must distrust the workspace, verify the current state against the mission, and repair notes.html until all six criteria hold.',
  prompt: [
    `Heads up: ${DEVELOPER_NAME} is rescuing the stalled "${PROJECT_NAME}" project (verifying the`,
    "previous attempt's leftovers against the mission and finishing notes.html). You don't need",
    "to do anything — just confirm you've seen this note.",
  ].join(' '),
  evidenceTexts: [KICKOFF_MESSAGE, MISSION_OBJECTIVES],
  timeoutMs: 20 * 60_000,
  progressTimeoutMs: 10 * 60_000,
  setup,
  skipInitialPrompt: true,
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const { client, logChanged, recordSniff } = ctx;
    const projectId = await findProjectId(client);
    if (!projectId) {
      logChanged('project', '[scenario] pocket-notes project not present yet');
      return { done: false };
    }

    const [html, doneMd] = await Promise.all([
      readWorkspaceText(client, projectId, NOTES_PATH),
      readWorkspaceText(client, projectId, DONE_PATH),
    ]);

    const criteria = checkNotesCriteria(html);
    const redFlag = criteria.failures.length > 0 && detectDoneClaim(doneMd);
    const failReason = composeRescueFailReason(criteria, doneMd);

    logChanged(
      'sniff',
      `[scenario] stale-workspace-rescue ${NOTES_PATH} bytes=${criteria.bytes} score=${criteria.signals.length}/${RESCUE_SIGNALS.length} signals=${criteria.signals.join(',') || 'none'}${redFlag ? ' redFlag=done-claim-vs-failing-criteria' : ''}${failReason ? ` failReason="${failReason}"` : ''}`,
    );
    recordSniff?.({
      key: 'stale-workspace-rescue',
      score: criteria.signals.length,
      bytes: criteria.bytes,
    });

    if (criteria.ok) {
      return {
        done: true,
        success: true,
        reason: `all ${RESCUE_SIGNALS.length} mission criteria verified on the current ${NOTES_PATH} (${criteria.signals.join(', ')})`,
      };
    }

    if (failReason) {
      await postSniffFeedback(
        ctx,
        NOTES_PATH,
        {
          ok: false,
          signals: criteria.signals,
          score: criteria.signals.length,
          failReason,
          missingRequiredSignals: criteria.missingRequiredSignals,
        },
        { repairDirective: rescueRepairDirective(criteria), sourceText: html ?? undefined },
      );
    }
    return { done: false };
  },
};
