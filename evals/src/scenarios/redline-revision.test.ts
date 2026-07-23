import { describe, expect, it } from 'vitest';
import {
  REDLINE_KICKOFF_MESSAGE,
  REDLINE_MISSION_OBJECTIVES,
  REDLINE_REVISION_1_MESSAGE,
  REDLINE_REVISION_2_MESSAGE,
  checkRedlinePhase,
  detectAddButton,
  detectDarkTheme,
  detectEnterKeyHandling,
  detectExternalReferences,
  redlineRevisionScenario,
} from './redline-revision.ts';

// ─────────────────────────────────────────────────────────────────────
// Reference fixtures — one per phase. The FINAL reference must pass all
// three phases (phase 1's add-mechanism accepts button OR Enter, so the
// button-less final page still satisfies every phase's core).

// Phase 1: light theme, Add button — exactly what the kickoff asks for.
const PHASE1_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Habit Tracker</title>
<style>
  body { background: #ffffff; color: #222; font-family: sans-serif; }
  ul { padding-left: 20px; }
</style>
</head>
<body>
<h1>Habit Tracker</h1>
<input id="habit-input" placeholder="New habit">
<button id="add-habit">Add</button>
<ul id="habit-list"></ul>
<script>
  var input = document.getElementById('habit-input');
  var list = document.getElementById('habit-list');
  var habits = [];
  function render() {
    list.innerHTML = '';
    for (var i = 0; i < habits.length; i++) {
      var li = document.createElement('li');
      li.textContent = habits[i];
      list.appendChild(li);
    }
  }
  document.getElementById('add-habit').addEventListener('click', function () {
    if (input.value.trim() !== '') {
      habits.push(input.value.trim());
      input.value = '';
      render();
    }
  });
</script>
</body>
</html>`;

// Phase 2: phase-1 shape + dark theme (button still present, no counter).
const PHASE2_HTML = PHASE1_HTML.replace(
  'body { background: #ffffff; color: #222; font-family: sans-serif; }',
  'body { background: #121212; color: #f5f5f5; font-family: sans-serif; }',
);

// Final: dark theme, Enter-key adding, counter, NO Add button, offline.
const FINAL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Habit Tracker</title>
<style>
  body { background: #121212; color: #f5f5f5; font-family: sans-serif; }
  #habit-list li { padding: 4px 0; }
</style>
</head>
<body>
<h1>Habit Tracker</h1>
<input id="habit-input" placeholder="New habit (press Enter)">
<p>Total habits: <span id="habit-count">0</span></p>
<ul id="habit-list"></ul>
<script>
  const input = document.getElementById('habit-input');
  const list = document.getElementById('habit-list');
  const counter = document.getElementById('habit-count');
  const habits = [];
  function render() {
    list.innerHTML = '';
    for (const habit of habits) {
      const li = document.createElement('li');
      li.textContent = habit;
      list.appendChild(li);
    }
    counter.textContent = String(habits.length);
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim() !== '') {
      habits.push(input.value.trim());
      input.value = '';
      render();
    }
  });
  render();
</script>
</body>
</html>`;

// Regression case: the final page with a CDN script re-added — the
// exact "constraint regressed during a revision" failure the scenario
// exists to measure.
const FINAL_WITH_CDN_HTML = FINAL_HTML.replace(
  '<script>',
  '<script src="https://cdn.example.com/helper.min.js"></script>\n<script>',
);

describe('redline-revision — seeded/empty state fails every phase', () => {
  it('an empty string fails phase 1 with every content signal missing', () => {
    const check = checkRedlinePhase('', 1);
    expect(check.ok).toBe(false);
    expect(check.missingRequiredSignals).toEqual([
      'title',
      'input-field',
      'add-mechanism',
      'habit-list',
      'render-js',
      'js-parses',
    ]);
    // The offline scan is vacuously satisfied by an empty file — the
    // content signals above are what gate; an empty page can't pass.
    expect(check.signals).toEqual(['offline-no-external-refs']);
    expect(check.failReason).toMatch(/Habit Tracker/i);
  });

  it('an empty string fails phases 2 and 3 too', () => {
    expect(checkRedlinePhase('', 2).ok).toBe(false);
    expect(checkRedlinePhase('', 3).ok).toBe(false);
  });
});

describe('redline-revision — staged references pass exactly their phases', () => {
  it('the phase-1 reference passes phase 1', () => {
    const check = checkRedlinePhase(PHASE1_HTML, 1);
    expect(check.failReason).toBeUndefined();
    expect(check.ok).toBe(true);
  });

  it('the phase-1 reference fails phase 2 on the dark-theme signal only', () => {
    const check = checkRedlinePhase(PHASE1_HTML, 2);
    expect(check.ok).toBe(false);
    expect(check.missingRequiredSignals).toEqual(['dark-theme']);
  });

  it('the phase-2 reference passes phases 1 and 2', () => {
    expect(checkRedlinePhase(PHASE2_HTML, 1).ok).toBe(true);
    const check = checkRedlinePhase(PHASE2_HTML, 2);
    expect(check.failReason).toBeUndefined();
    expect(check.ok).toBe(true);
  });

  it('the phase-2 reference fails phase 3 on the revision-2 deltas', () => {
    const check = checkRedlinePhase(PHASE2_HTML, 3);
    expect(check.ok).toBe(false);
    expect(check.missingRequiredSignals).toEqual([
      'enter-key',
      'habit-counter',
      'add-button-removed',
    ]);
  });

  it('the final reference passes ALL phases', () => {
    for (const phase of [1, 2, 3] as const) {
      const check = checkRedlinePhase(FINAL_HTML, phase);
      expect(check.failReason, `phase ${phase}`).toBeUndefined();
      expect(check.ok, `phase ${phase}`).toBe(true);
    }
  });
});

describe('redline-revision — offline-constraint regression', () => {
  it('a final page that re-added a CDN script fails the offline signal at phase 3', () => {
    const check = checkRedlinePhase(FINAL_WITH_CDN_HTML, 3);
    expect(check.ok).toBe(false);
    expect(check.missingRequiredSignals).toContain('offline-no-external-refs');
    expect(check.failReason).toMatch(/cdn\.example\.com/);
    expect(check.failReason).toMatch(/offline/i);
  });

  it('remote fetch(), <link href>, and @import are all flagged; w3.org noise is not', () => {
    expect(detectExternalReferences('fetch("https://api.example.com/habits")')).toHaveLength(1);
    expect(
      detectExternalReferences('<link href="https://fonts.googleapis.com/css2" rel="stylesheet">'),
    ).toHaveLength(1);
    expect(detectExternalReferences('@import url(https://example.com/theme.css);')).toHaveLength(1);
    expect(
      detectExternalReferences('<html xmlns="http://www.w3.org/1999/xhtml"><input></html>'),
    ).toHaveLength(0);
    expect(detectExternalReferences(FINAL_HTML)).toHaveLength(0);
    // A commented-out CDN reference is removed, not active.
    expect(
      detectExternalReferences('<!-- <script src="https://cdn.example.com/x.js"></script> -->'),
    ).toHaveLength(0);
  });
});

describe('redline-revision — detectors accept multiple idioms', () => {
  it('dark theme: prefers-color-scheme, body class, rgb(), and custom-property idioms', () => {
    expect(detectDarkTheme('<style>@media (prefers-color-scheme: dark) {}</style>')).toBe(true);
    expect(detectDarkTheme('<body class="dark-mode theme">')).toBe(true);
    expect(detectDarkTheme('<style>body { background: rgb(18, 18, 24); }</style>')).toBe(true);
    expect(detectDarkTheme('<style>:root { --bg-color: #0d1117; }</style>')).toBe(true);
    expect(detectDarkTheme('<style>body { background-color: black; }</style>')).toBe(true);
    // Light pages must NOT read as dark.
    expect(detectDarkTheme('<style>body { background: #ffffff; }</style>')).toBe(false);
    expect(detectDarkTheme('<style>body { background: #f0f0f0; }</style>')).toBe(false);
  });

  it('enter key: listener, attribute, key check, and form-submit idioms', () => {
    expect(detectEnterKeyHandling("input.addEventListener('keypress', onKey)")).toBe(true);
    expect(detectEnterKeyHandling('<input onkeydown="maybeAdd(event)">')).toBe(true);
    expect(detectEnterKeyHandling('if (e.keyCode === 13) addHabit();')).toBe(true);
    expect(detectEnterKeyHandling("form.addEventListener('submit', addHabit)")).toBe(true);
    expect(detectEnterKeyHandling('<form onsubmit="return addHabit()">')).toBe(true);
    expect(detectEnterKeyHandling('<button onclick="add()">Add</button>')).toBe(false);
  });

  it('add button: label, id/class, and input[type=submit] idioms — without padding false-positives', () => {
    expect(detectAddButton('<button>Add habit</button>')).toBe(true);
    expect(detectAddButton('<button id="add-btn">+</button>')).toBe(true);
    expect(detectAddButton('<input type="submit" value="Add">')).toBe(true);
    expect(detectAddButton('<button class="padding-large">Clear</button>')).toBe(false);
    expect(detectAddButton(FINAL_HTML)).toBe(false);
  });
});

describe('redline-revision — grader-lint mirror (not registered in index.ts yet)', () => {
  // Mirrors grader-lint.test.ts: every required signal's pattern must be
  // satisfiable from the user-shaped texts (prompt + evidenceTexts).
  const userShapedText = [
    redlineRevisionScenario.prompt,
    ...(redlineRevisionScenario.evidenceTexts ?? []),
  ]
    .join('\n')
    .toLowerCase();

  for (const evidence of redlineRevisionScenario.requiredPromptEvidence ?? []) {
    it(`required signal "${evidence.signal}" is satisfiable from user-shaped text`, () => {
      evidence.pattern.lastIndex = 0;
      expect(evidence.pattern.test(userShapedText)).toBe(true);
    });
  }

  it('evidenceTexts carries the mission + kickoff + both revision messages', () => {
    expect(redlineRevisionScenario.evidenceTexts).toEqual([
      REDLINE_MISSION_OBJECTIVES,
      REDLINE_KICKOFF_MESSAGE,
      REDLINE_REVISION_1_MESSAGE,
      REDLINE_REVISION_2_MESSAGE,
    ]);
  });

  it('the kickoff states the offline constraint and revision 2 restates it', () => {
    expect(REDLINE_KICKOFF_MESSAGE).toMatch(/OFFLINE/);
    expect(REDLINE_KICKOFF_MESSAGE).toMatch(/including after any future revisions/i);
    expect(REDLINE_REVISION_2_MESSAGE).toMatch(/offline constraint from the original brief/i);
    // Revision 1 deliberately does NOT restate it — that is the test.
    expect(REDLINE_REVISION_1_MESSAGE).not.toMatch(/offline/i);
  });
});
