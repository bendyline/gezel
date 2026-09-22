/**
 * One sentence per shared tool, tuned for the small on-device models the
 * portable host runs. The desktop keeps its own longer, eval-tuned prose for
 * the same tools; the input contracts in `./inputs.js` are what both share.
 */
export const TOOL_DESCRIPTIONS = {
  ask_user_question:
    'Ask the user a question and end your turn. Their answer arrives in this conversation. Include choices for bounded decisions.',
  list_gilde: 'List bundled crew templates.',
  create_task: 'Create a task with explicit steps in this project.',
  advance_task_step: 'Check the completion gate and advance the active task step.',
  list_gezels: 'List the named crew.',
  ensure_gezel: 'Reuse or recruit a gezel for a job.',
  list_projects: 'List projects and their ids.',
  update_project: 'Update project brief, objectives or lead.',
  start_project: 'Create a project, lead and kickoff task, then hand off the brief.',
  list_project_gezels: 'List this project crew.',
  add_gezel_to_project: 'Add an existing gezel to a project.',
  message_gezel:
    'Hand work to a crew member; the reply appears in their conversation. End your turn after sending.',
  list_dir: 'List workspace files.',
  read_file: 'Read a workspace text file.',
  write_file: 'Write a workspace text file.',
  append_to_file:
    'Append only the missing tail to an existing workspace file. Set create:true explicitly to create a missing file.',
  replace_in_file:
    'Edit an existing workspace file with a literal find/replace. By default exactly one match is required; occurrence selects a 1-based match or all. Returns the saved path and size.',
  replace_lines:
    'Replace an inclusive 1-based line range in an existing workspace file. Empty content deletes the range. Read current line numbers after each edit.',
  list_artifacts: 'List project artifacts.',
  read_artifact: 'Read a project artifact.',
  write_artifact: 'Save supporting notes or a report to the project artifacts.',
  list_documents: 'List the shared document library.',
  read_document: 'Read a shared text document.',
  write_document: 'Save shared guidelines or reference text.',
  search: 'Search text in this project.',
  search_memory: 'Search your own or this project memories.',
  save_memory: 'Save a durable note for yourself or this project.',
  read_task_notes: 'Read dated task notes, newest first. Omit stepId for the complete feed.',
  write_task_note: 'Append a focused dated note to the current task, attributed to you.',
  list_tasks: 'List tasks in this project.',
  get_task: 'Read a task and its steps.',
  list_scripts:
    'List installed project, user and standard scripts with input fields and required capabilities.',
  run_installed_script:
    'Run an installed script by name from list_scripts. Default scope is project. Input is validated; declared capabilities and project policy are enforced.',
  get_script_run: 'Read a persisted script run, output, logs and call audit.',
} as const satisfies Record<string, string>;

export type SharedToolName = keyof typeof TOOL_DESCRIPTIONS;
