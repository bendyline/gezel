/**
 * One accepted and one rejected call for every tool the portable host
 * offers. Both hosts register these tools; the fixtures let a contract test
 * hold the two schemas to the same answer for the same arguments.
 */
export interface ToolCallFixture {
  tool: string;
  args: Record<string, unknown>;
  expect: 'accept' | 'reject';
}

const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
  ['ask_user_question', { question: 'Which colour?', choices: ['red', 'blue'] }, { question: 5 }],
  ['list_gilde', {}, { extra: 1 }],
  [
    'create_task',
    {
      project: 'p',
      title: 'Ship it',
      description: 'A description long enough to satisfy the forty character floor.',
      steps: [{ name: 'Build', prompt: 'Build the thing' }],
    },
    { title: 'Ship it' },
  ],
  ['advance_task_step', { ref: 'default/1', stepId: 'build' }, {}],
  ['list_gezels', {}, { extra: 1 }],
  ['ensure_gezel', { jobTitle: 'Writer' }, {}],
  ['list_projects', {}, { extra: 1 }],
  ['update_project', { id: 'p', name: 'New name' }, {}],
  ['start_project', { name: 'Launch' }, {}],
  ['list_project_gezels', {}, { project: 1 }],
  ['add_gezel_to_project', { project: 'p', gezel: 'g' }, { project: 'p' }],
  ['message_gezel', { gezel: 'g', message: 'hello' }, { gezel: 'g', message: '' }],
  ['list_dir', {}, { path: 1 }],
  ['read_file', { path: 'notes.md' }, {}],
  ['write_file', { path: 'notes.md', content: 'x' }, { path: 'notes.md' }],
  ['append_to_file', { path: 'notes.md', content: 'x' }, {}],
  [
    'replace_in_file',
    { path: 'notes.md', find: 'a', replace: 'b' },
    { path: 'notes.md', find: '', replace: 'b' },
  ],
  [
    'replace_lines',
    { path: 'notes.md', startLine: 1, endLine: 1, content: '' },
    { path: 'notes.md' },
  ],
  ['list_artifacts', {}, { path: 1 }],
  ['read_artifact', { path: 'report.md' }, {}],
  ['write_artifact', { path: 'report.md', content: 'x' }, { content: 'x' }],
  ['list_documents', {}, { path: 1 }],
  ['read_document', { path: 'guide.md' }, {}],
  ['write_document', { path: 'guide.md', content: 'x' }, {}],
  ['search', { query: 'thrust' }, {}],
  ['search_memory', { query: 'thrust' }, {}],
  ['save_memory', { text: 'Remember this', scope: 'gezel' }, {}],
  ['read_task_notes', { ref: 'default/1' }, {}],
  ['write_task_note', { ref: 'default/1', note: 'Done' }, {}],
  ['list_tasks', {}, { extra: 1 }],
  ['get_task', { ref: 'default/1' }, {}],
  ['list_scripts', {}, { project: 1 }],
  ['run_installed_script', { name: 'probe' }, {}],
  ['get_script_run', { runId: 'r1' }, {}],
];

export const TOOL_CALL_FIXTURES: readonly ToolCallFixture[] = cases.flatMap(
  ([tool, accept, reject]) => [
    { tool, args: accept, expect: 'accept' as const },
    { tool, args: reject, expect: 'reject' as const },
  ],
);
