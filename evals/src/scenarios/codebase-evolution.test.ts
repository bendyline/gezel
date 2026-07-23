import type { GezelClient } from '@bendyline/gezel-client/node';
import { describe, expect, it } from 'vitest';
import type { EvalContext } from '../types.ts';
import {
  APP_PATH,
  CODEBASE_EVOLUTION_MISSION,
  type CodebaseFiles,
  INDEX_PATH,
  PHASE_1_MESSAGE,
  PHASE_2_MESSAGE,
  PHASE_3_MESSAGE,
  PHASE_4_MESSAGE,
  type PhaseCheck,
  RENDERED_TASK_SELECTOR,
  RENDER_PATH,
  STATE_PATH,
  checkCodebasePhase,
  checkCodebaseRuntime,
  checkModuleGraph,
  codebaseEvolutionScenario,
  codebaseRuntimeFailureKey,
  feedbackPathForPhase,
  recordCodebaseRuntimeFailureAttempt,
} from './codebase-evolution.ts';

const PHASE1_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Launch Board</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 24px; }
    .board { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    section { border: 1px solid #ccc; padding: 12px; min-height: 140px; }
  </style>
</head>
<body>
  <h1>Launch Board</h1>
  <form id="task-form">
    <label>Task title <input id="task-title" name="task-title"></label>
    <button>Add task</button>
  </form>
  <div class="board">
    <section data-status="backlog"><h2>Backlog</h2><ul id="backlog-list"></ul></section>
    <section data-status="doing"><h2>Doing</h2><ul id="doing-list"></ul></section>
    <section data-status="done"><h2>Done</h2><ul id="done-list"></ul></section>
  </div>
  <script>
    const storageKey = 'launch-board-tasks';
    let tasks = JSON.parse(localStorage.getItem(storageKey) || 'null') || [
      { id: 1, title: 'Confirm launch copy', status: 'backlog' },
      { id: 2, title: 'QA signup flow', status: 'doing' },
      { id: 3, title: 'Publish release notes', status: 'done' }
    ];
    const lists = {
      backlog: document.getElementById('backlog-list'),
      doing: document.getElementById('doing-list'),
      done: document.getElementById('done-list')
    };
    function saveTasks() {
      localStorage.setItem(storageKey, JSON.stringify(tasks));
    }
    function renderTasks() {
      Object.values(lists).forEach((list) => { list.innerHTML = ''; });
      tasks.forEach((task) => {
        const li = document.createElement('li');
        li.textContent = task.title;
        lists[task.status].appendChild(li);
      });
    }
    document.getElementById('task-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const input = document.getElementById('task-title');
      if (!input.value.trim()) return;
      tasks.push({ id: Date.now(), title: input.value.trim(), status: 'backlog' });
      input.value = '';
      saveTasks();
      renderTasks();
    });
    renderTasks();
  </script>
</body>
</html>`;

const PHASE2_HTML = PHASE1_HTML.replace(
  '<button>Add task</button>',
  `<label>Priority
      <select id="task-priority" name="priority">
        <option>Low</option>
        <option>Medium</option>
        <option>High</option>
      </select>
    </label>
    <button>Add task</button>
    <label>Filter by priority
      <select id="priority-filter">
        <option value="all">All priorities</option>
        <option>Low</option>
        <option>Medium</option>
        <option>High</option>
      </select>
    </label>`,
)
  .replace(
    "{ id: 1, title: 'Confirm launch copy', status: 'backlog' }",
    "{ id: 1, title: 'Confirm launch copy', status: 'backlog', priority: 'High' }",
  )
  .replace(
    "{ id: 2, title: 'QA signup flow', status: 'doing' }",
    "{ id: 2, title: 'QA signup flow', status: 'doing', priority: 'Medium' }",
  )
  .replace(
    "{ id: 3, title: 'Publish release notes', status: 'done' }",
    "{ id: 3, title: 'Publish release notes', status: 'done', priority: 'Low' }",
  )
  .replace(
    'tasks.forEach((task) => {',
    "const selectedPriority = document.getElementById('priority-filter').value; tasks.filter((task) => selectedPriority === 'all' || task.priority === selectedPriority).forEach((task) => {",
  )
  .replace(
    "tasks.push({ id: Date.now(), title: input.value.trim(), status: 'backlog' });",
    "tasks.push({ id: Date.now(), title: input.value.trim(), status: 'backlog', priority: document.getElementById('task-priority').value });",
  )
  .replace(
    'renderTasks();\n  </script>',
    "document.getElementById('priority-filter').addEventListener('change', renderTasks);\n    renderTasks();\n  </script>",
  );

const PHASE3_HTML = PHASE2_HTML.replace(
  '<button>Add task</button>',
  `<label>Due date <input id="task-due-date" name="dueDate" type="date"></label>
    <button>Add task</button>`,
)
  .replace(
    '<div class="board">',
    `<div id="due-summary">
    <strong>Overdue</strong> <span id="overdue-count">0</span>
    <strong>Today</strong> <span id="today-count">0</span>
    <strong>Upcoming</strong> <span id="upcoming-count">0</span>
  </div>
  <div class="board">`,
  )
  .replace(/priority: 'High' }/g, "priority: 'High', dueDate: '2026-06-17' }")
  .replace(/priority: 'Medium' }/g, "priority: 'Medium', dueDate: '2026-06-18' }")
  .replace(/priority: 'Low' }/g, "priority: 'Low', dueDate: '2026-06-20' }")
  .replace(
    'li.textContent = task.title;',
    "li.textContent = task.title + ' - ' + task.priority + ' - due ' + task.dueDate;",
  )
  .replace(
    "tasks.push({ id: Date.now(), title: input.value.trim(), status: 'backlog', priority: document.getElementById('task-priority').value });",
    "tasks.push({ id: Date.now(), title: input.value.trim(), status: 'backlog', priority: document.getElementById('task-priority').value, dueDate: document.getElementById('task-due-date').value });",
  )
  .replace(
    'function renderTasks() {',
    `function classifyDueDate(dueDate) {
      const today = new Date();
      const target = new Date(dueDate + 'T00:00:00');
      if (target.toDateString() === today.toDateString()) return 'today';
      return target < today ? 'overdue' : 'upcoming';
    }
    function renderSummary() {
      const counts = { overdue: 0, today: 0, upcoming: 0 };
      tasks.forEach((task) => { counts[classifyDueDate(task.dueDate)] += 1; });
      document.getElementById('overdue-count').textContent = counts.overdue;
      document.getElementById('today-count').textContent = counts.today;
      document.getElementById('upcoming-count').textContent = counts.upcoming;
    }
    function renderTasks() {`,
  )
  .replace(
    'saveTasks();\n      renderTasks();',
    'saveTasks();\n      renderSummary();\n      renderTasks();',
  )
  .replace('renderTasks();\n  </script>', 'renderSummary();\n    renderTasks();\n  </script>');

const FINAL_FILES: CodebaseFiles = {
  [INDEX_PATH]: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Launch Board</title></head>
<body>
  <h1>Launch Board</h1>
  <form id="task-form">
    <input id="task-title" name="task-title">
    <select id="task-priority" name="priority"><option>Low</option><option>Medium</option><option>High</option></select>
    <input id="task-due-date" name="dueDate" type="date">
    <button>Add task</button>
  </form>
  <select id="priority-filter"><option value="all">All priorities</option><option>Low</option><option>Medium</option><option>High</option></select>
  <div id="due-summary"><span>Overdue</span><span id="overdue-count"></span><span>Today</span><span id="today-count"></span><span>Upcoming</span><span id="upcoming-count"></span></div>
  <section><h2>Backlog</h2><ul id="backlog-list"></ul></section>
  <section><h2>Doing</h2><ul id="doing-list"></ul></section>
  <section><h2>Done</h2><ul id="done-list"></ul></section>
  <script type="module" src="./src/app.js"></script>
</body>
</html>`,
  [STATE_PATH]: `const storageKey = 'launch-board-tasks';
export let tasks = JSON.parse(localStorage.getItem(storageKey) || 'null') || [
  { id: 1, title: 'Confirm launch copy', status: 'backlog', priority: 'High', dueDate: '2026-06-17' },
  { id: 2, title: 'QA signup flow', status: 'doing', priority: 'Medium', dueDate: '2026-06-18' },
  { id: 3, title: 'Publish release notes', status: 'done', priority: 'Low', dueDate: '2026-06-20' }
];
export function addTask(task) {
  tasks = [...tasks, task];
  localStorage.setItem(storageKey, JSON.stringify(tasks));
}`,
  [RENDER_PATH]: `export function renderBoard(tasks, priorityFilter) {
  for (const status of ['backlog', 'doing', 'done']) document.getElementById(status + '-list').innerHTML = '';
  tasks.filter((task) => priorityFilter === 'all' || task.priority === priorityFilter).forEach((task) => {
    const li = document.createElement('li');
    li.textContent = task.title + ' - ' + task.priority + ' - due ' + task.dueDate;
    document.getElementById(task.status + '-list').appendChild(li);
  });
}
export function renderSummary(tasks) {
  const counts = { overdue: 0, today: 0, upcoming: 0 };
  const today = new Date();
  tasks.forEach((task) => {
    const due = new Date(task.dueDate + 'T00:00:00');
    const bucket = due.toDateString() === today.toDateString() ? 'today' : due < today ? 'overdue' : 'upcoming';
    counts[bucket] += 1;
  });
  document.getElementById('overdue-count').textContent = counts.overdue;
  document.getElementById('today-count').textContent = counts.today;
  document.getElementById('upcoming-count').textContent = counts.upcoming;
}`,
  [APP_PATH]: `import { addTask, tasks } from './state.js';
import { renderBoard, renderSummary } from './render.js';
function draw() {
  renderBoard(tasks, document.getElementById('priority-filter').value);
  renderSummary(tasks);
}
document.getElementById('task-form').addEventListener('submit', (event) => {
  event.preventDefault();
  addTask({
    id: Date.now(),
    title: document.getElementById('task-title').value,
    status: 'backlog',
    priority: document.getElementById('task-priority').value,
    dueDate: document.getElementById('task-due-date').value
  });
  draw();
});
document.getElementById('priority-filter').addEventListener('change', draw);
draw();
export { draw };`,
};

function makeWorkspaceContext(files: CodebaseFiles): EvalContext {
  const client = {
    listProjectWorkspace: async () => ({
      files: Object.keys(files).map((path) => ({ path, isDirectory: false })),
    }),
    fetchProjectWorkspaceBlob: async (_projectId: string, path: string) =>
      new Blob([files[path] ?? ''], { type: 'text/plain' }),
  } as unknown as GezelClient;
  return {
    client,
    meesterId: 'meester',
    log: () => {},
    logChanged: () => {},
  };
}

it('tracks repeated runtime failure shapes for the phase 4 cap', () => {
  const state = { runtimeFailureKey: undefined as string | undefined, runtimeFailureCount: 0 };
  const seedOnly = {
    ran: true,
    passed: ['no-page-errors'],
    failed: [{ name: 'seed-tasks-render', why: 'found 0' }],
    pageErrors: [],
  };
  const sameNamesDifferentOrder = {
    ran: true,
    passed: [],
    failed: [
      { name: 'seed-tasks-render', why: 'found 0' },
      { name: 'no-page-errors', why: 'ReferenceError' },
    ],
    pageErrors: ['ReferenceError'],
  };
  const sameNamesReordered = {
    ran: true,
    passed: [],
    failed: [
      { name: 'no-page-errors', why: 'ReferenceError' },
      { name: 'seed-tasks-render', why: 'found 0' },
    ],
    pageErrors: ['ReferenceError'],
  };

  expect(codebaseRuntimeFailureKey(sameNamesDifferentOrder)).toBe(
    codebaseRuntimeFailureKey(sameNamesReordered),
  );
  expect(recordCodebaseRuntimeFailureAttempt(state, seedOnly, 'artifact-a')).toBe(1);
  expect(recordCodebaseRuntimeFailureAttempt(state, seedOnly, 'artifact-a')).toBe(1);
  expect(recordCodebaseRuntimeFailureAttempt(state, seedOnly, 'artifact-b')).toBe(2);
  expect(recordCodebaseRuntimeFailureAttempt(state, sameNamesDifferentOrder, 'artifact-c')).toBe(1);
  expect(recordCodebaseRuntimeFailureAttempt(state, sameNamesReordered, 'artifact-c')).toBe(1);
  expect(recordCodebaseRuntimeFailureAttempt(state, sameNamesReordered, 'artifact-d')).toBe(2);
});

describe('codebase-evolution phased checks', () => {
  it('phase 1 accepts a monolithic Launch Board app and rejects later requirements', () => {
    const files = { [INDEX_PATH]: PHASE1_HTML };
    expect(checkCodebasePhase(files, 1).ok).toBe(true);
    const phase2 = checkCodebasePhase(files, 2);
    expect(phase2.ok).toBe(false);
    expect(phase2.missingRequiredSignals).toEqual([
      'priority-values',
      'priority-input',
      'priority-filter',
    ]);
  });

  it('phase 1 accepts seeded tasks named with common label fields', () => {
    const files = {
      [INDEX_PATH]: PHASE1_HTML.replaceAll('title:', 'name:').replaceAll('task.title', 'task.name'),
    };
    const check = checkCodebasePhase(files, 1);
    expect(check.ok).toBe(true);
    expect(check.signals).toContain('seed-tasks');
  });

  it('phase 1 accepts seeded tasks named with content fields', () => {
    const files = {
      [INDEX_PATH]: PHASE1_HTML.replaceAll('title:', 'content:').replaceAll(
        'task.title',
        'task.content',
      ),
    };
    const check = checkCodebasePhase(files, 1);
    expect(check.ok).toBe(true);
    expect(check.signals).toContain('seed-tasks');
  });

  it('phase 1 accepts seeded tasks created through task factory calls', () => {
    const html = `<!doctype html>
      <h1>Launch Board</h1>
      <form id="task-form"><input id="task-title"><button>Add Task</button></form>
      <section>Backlog</section><section>Doing</section><section>Done</section>
      <script>
        const STORAGE_KEY = 'launchBoardTasks';
        let tasks = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        function addTask(title, priority) {
          tasks.push({ id: Date.now(), title, priority, status: 'Backlog' });
          localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
        }
        if (tasks.length === 0) {
          addTask("Design landing page mockups", "High");
          addTask("Set up basic project structure", "Medium");
          addTask("Write initial README documentation", "Low");
        }
      </script>`;
    const check = checkCodebasePhase({ [INDEX_PATH]: html }, 1);
    expect(check.ok).toBe(true);
    expect(check.signals).toContain('seed-tasks');
  });

  it('distinguishes a present but thin index.html from a missing file', () => {
    const check = checkCodebasePhase(
      {
        [INDEX_PATH]:
          '<h1>Launch Board</h1><section>Backlog</section><section>Doing</section><section>Done</section>',
      },
      1,
    );
    expect(check.signals).toContain('index-present');
    expect(check.missingRequiredSignals).not.toContain('index-present');
    expect(check.missingRequiredSignals).toContain('phase1-monolithic');
  });

  it('phase 2 accepts priority support and still rejects due-date requirements', () => {
    const files = { [INDEX_PATH]: PHASE2_HTML };
    expect(checkCodebasePhase(files, 1).ok).toBe(true);
    expect(checkCodebasePhase(files, 2).ok).toBe(true);
    const phase3 = checkCodebasePhase(files, 3);
    expect(phase3.ok).toBe(false);
    expect(phase3.missingRequiredSignals).toContain('due-date-input');
    expect(phase3.missingRequiredSignals).toContain('due-summary');
  });

  it('phase 2 prompt asks for priority as stored state plus visible controls', () => {
    expect(PHASE_2_MESSAGE).toContain('workspace `replaceInFile` or `writeFile`');
    expect(PHASE_2_MESSAGE).toContain('`priority` field');
    expect(PHASE_2_MESSAGE).toContain('visible priority select/input');
    expect(PHASE_2_MESSAGE).toContain('visible priority filter');
    expect(PHASE_2_MESSAGE).toContain('render loop');
  });

  it('phase 2 accepts conditional render-loop priority filtering', () => {
    const html = PHASE2_HTML.replace(
      "const selectedPriority = document.getElementById('priority-filter').value; tasks.filter((task) => selectedPriority === 'all' || task.priority === selectedPriority).forEach((task) => {",
      "const currentPriorityFilter = document.getElementById('priority-filter').value; tasks.forEach((task) => { if (currentPriorityFilter !== 'all' && task.priority !== currentPriorityFilter) return;",
    );

    const check = checkCodebasePhase({ [INDEX_PATH]: html }, 2);
    expect(check.ok).toBe(true);
    expect(check.signals).toContain('priority-filter');
  });

  it('phase 2 accepts priority filtering with a short task variable alias', () => {
    const html = PHASE2_HTML.replace(
      "const selectedPriority = document.getElementById('priority-filter').value; tasks.filter((task) => selectedPriority === 'all' || task.priority === selectedPriority).forEach((task) => {",
      "const filter = document.getElementById('priority-filter').value; tasks.forEach((t) => { if (filter !== 'all' && t.priority !== filter) return;",
    );

    const check = checkCodebasePhase({ [INDEX_PATH]: html }, 2);
    expect(check.ok).toBe(true);
    expect(check.signals).toContain('priority-filter');
  });

  it('phase 2 rejects CSS filter styling plus status-only filtering as priority filtering', () => {
    const html = `
      <title>Launch Board</title>
      <style>
        .filter-bar select { padding: 4px; }
        .priority-high { color: red; }
      </style>
      <form id="add-form"><input id="task-input" type="text" placeholder="New task" /></form>
      <section>Backlog</section><section>Doing</section><section>Done</section>
      <script>
        const tasks = [
          { id: 1, text: "Define project scope", status: "done", priority: "high" },
          { id: 2, text: "Set up CI/CD pipeline", status: "doing", priority: "medium" },
          { id: 3, text: "Write user documentation", status: "backlog", priority: "low" },
        ];
        localStorage.setItem("launch-board-tasks", JSON.stringify(tasks));
        function render(status) {
          tasks.filter(t => t.status === status).forEach(task => {
            const badge = document.createElement("span");
            badge.className = "priority-" + task.priority;
          });
        }
      </script>
    `;

    const check = checkCodebasePhase({ [INDEX_PATH]: html }, 2);

    expect(check.signals).toContain('priority-values');
    expect(check.signals).not.toContain('priority-filter');
    expect(check.missingRequiredSignals).toContain('priority-filter');
  });

  it('phase 3 accepts due-date summary but still requires final modules', () => {
    const files = { [INDEX_PATH]: PHASE3_HTML };
    expect(checkCodebasePhase(files, 3).ok).toBe(true);
    const phase4 = checkCodebasePhase(files, 4);
    expect(phase4.ok).toBe(false);
    expect(phase4.missingRequiredSignals).toContain('module-script');
    expect(phase4.missingRequiredSignals).toContain('src-state-module');
    expect(phase4.missingRequiredSignals).toContain('inline-js-small');
  });

  it('phase 4 accepts a refactored multi-file ES module codebase', () => {
    const check = checkCodebasePhase(FINAL_FILES, 4, { moduleSyntaxOk: true });
    expect(check.failReason).toBeUndefined();
    expect(check.ok).toBe(true);
    expect(check.signals).toContain('module-script');
    expect(check.signals).toContain('module-imports-exports');
  });

  it('phase 4 accepts an app entrypoint that imports modules without exporting its own API', () => {
    const files = {
      ...FINAL_FILES,
      [APP_PATH]: FINAL_FILES[APP_PATH]!.replace(/\nexport \{ draw \};\s*$/, ''),
    };
    const check = checkCodebasePhase(files, 4, { moduleSyntaxOk: true });
    expect(check.ok).toBe(true);
    expect(check.signals).toContain('module-imports-exports');
  });

  it('runtime rendered-task selector counts generic card task markup', () => {
    expect(RENDERED_TASK_SELECTOR).toContain('.card');
    expect(RENDERED_TASK_SELECTOR).toContain('[data-id]');
  });

  it('runtime check passes rendered seed tasks in a module-based Launch Board', async () => {
    const report = await checkCodebaseRuntime(
      makeWorkspaceContext(FINAL_FILES),
      'launch-board',
      FINAL_FILES,
    );

    expect(report.bootstrapError).toBeUndefined();
    expect(report.ran).toBe(true);
    expect(report.failed).toEqual([]);
    expect(report.passed).toContain('no-page-errors');
    expect(report.passed).toContain('seed-tasks-render');
    expect(report.passed).toContain('add-task-persists');
  }, 30_000);

  it('phase 4 module graph rejects named imports that target missing exports', () => {
    const files = {
      ...FINAL_FILES,
      [STATE_PATH]: `export function addTask(task) { localStorage.setItem('tasks', JSON.stringify([task])); }`,
      [APP_PATH]: `import { addTask, load, moveTask } from './state.js';
import { renderBoard } from './render.js';
document.addEventListener('DOMContentLoaded', () => renderBoard([], 'all'));
export { addTask };`,
    };

    const graph = checkModuleGraph(files);
    expect(graph.ok).toBe(false);
    expect(graph.reason).toContain('imports load, moveTask from ./state.js');
  });

  it('phase 4 module graph rejects namespace member calls that target missing exports', () => {
    const files = {
      ...FINAL_FILES,
      [STATE_PATH]: `export function loadTasks() { return []; }
export function saveTasks(tasks) { localStorage.setItem('tasks', JSON.stringify(tasks)); }`,
      [APP_PATH]: `import * as State from './state.js';
import { renderBoard } from './render.js';
document.addEventListener('DOMContentLoaded', () => {
  State.loadInitialState();
  renderBoard([], 'all');
});`,
    };

    const graph = checkModuleGraph(files);
    expect(graph.ok).toBe(false);
    expect(graph.reason).toContain('uses State.loadInitialState from ./state.js');
  });

  it('phase 4 module graph rejects duplicate named exports', () => {
    const files = {
      ...FINAL_FILES,
      [RENDER_PATH]: `${FINAL_FILES[RENDER_PATH]}
export { renderBoard as renderTasks, renderSummary, renderSummary as calculateSummaryCounts };
export function calculateSummaryCounts(tasks) {
  return { overdue: tasks.length, today: 0, upcoming: 0 };
}`,
    };

    const graph = checkModuleGraph(files);
    expect(graph.ok).toBe(false);
    expect(graph.reason).toContain('src/render.js: duplicate exports');
    expect(graph.reason).toContain('calculateSummaryCounts');
  });

  it('phase 4 fails when modules are present but syntax has not passed', () => {
    const check = checkCodebasePhase(FINAL_FILES, 4, {
      moduleSyntaxOk: false,
      moduleSyntaxError: 'src/app.js: SyntaxError',
    });
    expect(check.ok).toBe(false);
    expect(check.missingRequiredSignals).toContain('module-syntax');
    expect(check.failReason).toContain('src/app.js: SyntaxError');
  });

  it('routes phase 4 index-shell feedback to index.html', () => {
    const check = checkCodebasePhase(
      {
        ...FINAL_FILES,
        [INDEX_PATH]: FINAL_FILES[INDEX_PATH]!.replace(
          '<script type="module" src="./src/app.js"></script>',
          '',
        ),
      },
      4,
      { moduleSyntaxOk: true },
    );

    expect(check.missingRequiredSignals).toContain('module-script');
    expect(feedbackPathForPhase(4, check)).toBe(INDEX_PATH);
  });

  it('routes phase 4 all-modules-missing feedback to index.html first', () => {
    const check = checkCodebasePhase({ [INDEX_PATH]: PHASE3_HTML }, 4, { moduleSyntaxOk: true });

    expect(check.missingRequiredSignals).toContain('module-script');
    expect(check.missingRequiredSignals).toContain('src-state-module');
    expect(check.missingRequiredSignals).toContain('src-render-module');
    expect(check.missingRequiredSignals).toContain('src-app-module');
    expect(feedbackPathForPhase(4, check)).toBe(INDEX_PATH);
  });

  it('routes phase 4 missing app-module feedback to src/app.js', () => {
    const { [APP_PATH]: _app, ...files } = FINAL_FILES;
    const check = checkCodebasePhase(files, 4, { moduleSyntaxOk: false });

    expect(check.missingRequiredSignals).toContain('src-app-module');
    expect(feedbackPathForPhase(4, check)).toBe(APP_PATH);
  });

  it('routes phase 4 missing date-logic feedback to src/render.js', () => {
    const check = {
      missingRequiredSignals: ['date-logic'],
      failReason: 'date-logic: The code must compute due-date status using Date/dueDate logic.',
    } as PhaseCheck;

    expect(feedbackPathForPhase(4, check)).toBe(RENDER_PATH);
  });

  it('routes phase 4 missing due-summary feedback to index.html', () => {
    const check = {
      missingRequiredSignals: ['due-summary'],
      failReason: 'due-summary: The UI must show Overdue, Today, and Upcoming summary counts.',
    } as PhaseCheck;

    expect(feedbackPathForPhase(4, check)).toBe(INDEX_PATH);
  });

  it('routes phase 4 missing seeded tasks feedback to src/state.js', () => {
    const check = {
      missingRequiredSignals: ['seed-tasks'],
      failReason: 'seed-tasks: Include at least three seeded task objects/items.',
    } as PhaseCheck;

    expect(feedbackPathForPhase(4, check)).toBe(STATE_PATH);
  });
});

describe('codebase-evolution prompt evidence', () => {
  it('uses setup as the sole kickoff path', () => {
    expect(codebaseEvolutionScenario.skipInitialPrompt).toBe(true);
  });

  it('registered requiredPromptEvidence is satisfiable from user-shaped texts', () => {
    const text = [
      codebaseEvolutionScenario.prompt,
      CODEBASE_EVOLUTION_MISSION,
      PHASE_1_MESSAGE,
      PHASE_2_MESSAGE,
      PHASE_3_MESSAGE,
      PHASE_4_MESSAGE,
    ]
      .join('\n')
      .toLowerCase();
    for (const entry of codebaseEvolutionScenario.requiredPromptEvidence ?? []) {
      expect(entry.pattern.test(text), entry.signal).toBe(true);
    }
  });

  it('phase 3 prompt asks for due-date state, input, summary, and date logic', () => {
    expect(PHASE_3_MESSAGE).toContain('workspace `writeFile` edit for `index.html`');
    expect(PHASE_3_MESSAGE).toContain('Priority is already done');
    expect(PHASE_3_MESSAGE).toContain('dueDate');
    expect(PHASE_3_MESSAGE).toContain('<input type="date" id="dueDateInput" name="dueDate">');
    expect(PHASE_3_MESSAGE).toContain('newly added tasks');
    expect(PHASE_3_MESSAGE).toContain('Overdue');
    expect(PHASE_3_MESSAGE).toContain('Today');
    expect(PHASE_3_MESSAGE).toContain('Upcoming');
    expect(PHASE_3_MESSAGE).toContain('new Date(task.dueDate)');
    expect(PHASE_3_MESSAGE).toContain('id="dueDateInput"');
  });
});
