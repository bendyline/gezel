import type { ProjectDetail } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { type BuildInstructionsOptions, buildInstructions } from './instructions.js';

function promptWithTools(names: string[]): string {
  return buildInstructions({
    name: 'Tomas',
    role: 'Meester',
    about: 'Route work to the right specialist.',
    executionDensity: 'flat',
    availableTools: names.map((name) => ({ name, description: `${name} tool` })),
  } as unknown as BuildInstructionsOptions).full;
}

describe('buildInstructions coordinator routing', () => {
  it('never coaches a coordinator to call unavailable start tools', () => {
    const prompt = promptWithTools(['ensure_gezel', 'message_gezel', 'create_task']);
    expect(prompt).toContain('`message_gezel`');
    expect(prompt).not.toContain('`start_job({');
    expect(prompt).not.toContain('`start_project({');
  });

  it('routes named binary formats through craftbooks without permitting markdown substitution', () => {
    const prompt = promptWithTools([
      'start_job',
      'suggest_craftbook',
      'invoke_craftbook',
      'convert_document',
      'preview_document',
      'save_artifact',
    ]);
    expect(prompt).toContain('Call `suggest_craftbook` exactly once');
    expect(prompt).toContain('NEXT tool call in this same turn must be `invoke_craftbook`');
    expect(prompt).toContain('takes precedence over generic project/job kickoff');
    expect(prompt).toContain('do not repeat the lookup with a rephrased query');
    expect(prompt).toContain('PowerPoint/PPTX');
    expect(prompt).toContain('Word/DOCX');
    expect(prompt).toContain('MP4, GIF');
    expect(prompt).toContain('do not silently substitute markdown');
    expect(prompt).toContain('author Markdown');
    expect(prompt).toContain('Do not recruit a developer');
    expect(prompt).toContain('Do not claim a project, task, or deliverable exists');
    expect(prompt).toContain('`convert_document`');
    expect(prompt).toContain('`save_artifact`');
  });

  it('recognizes Codex-qualified MCP names when generating routing guidance', () => {
    const prompt = promptWithTools([
      'mcp__gezel__ensure_gezel',
      'mcp__gezel__message_gezel',
      'mcp__gezel__start_project',
      'mcp__gezel__suggest_craftbook',
      'mcp__gezel__invoke_craftbook',
      'mcp__docblocks__convert_document',
    ]);

    expect(prompt).toContain(
      '`start_project({ name, about, missionObjectives, taskDescription })`',
    );
    expect(prompt).toContain('Call `suggest_craftbook` exactly once');
    expect(prompt).toContain('`ensure_gezel`');
    expect(prompt).toContain('`message_gezel`');
    expect(prompt).toContain('`convert_document`');
    expect(prompt).not.toContain(
      'Manage the team with the tools actually wired this turn (none wired)',
    );
    expect(prompt).not.toContain(
      'Manage projects and tasks with the tools actually wired this turn (none wired)',
    );
  });

  it('uses the advertised grep spelling in retrieval-first guidance', () => {
    const prompt = buildInstructions({
      name: 'Tomas',
      role: 'Meester',
      about: 'Route work to the right specialist.',
      executionDensity: 'flat',
      project: { id: 'default', name: 'Default' } as ProjectDetail,
      workspaceFiles: [{ path: 'src/app.ts', isDirectory: false }],
      retrievalFirstHint: true,
      availableTools: [{ name: 'grep_files', description: 'grep workspace files' }],
    } as unknown as BuildInstructionsOptions).full;

    expect(prompt).toContain('call `grep_files` — do not read files one by one');
  });

  it('emits search_files in the legacy naming A/B arm while resolving it canonically', () => {
    const prompt = buildInstructions({
      name: 'Tomas',
      role: 'Meester',
      about: 'Route work to the right specialist.',
      executionDensity: 'flat',
      project: { id: 'default', name: 'Default' } as ProjectDetail,
      workspaceFiles: [{ path: 'src/app.ts', isDirectory: false }],
      retrievalFirstHint: true,
      availableTools: [{ name: 'search_files', description: 'search workspace files' }],
    } as unknown as BuildInstructionsOptions).full;

    expect(prompt).toContain('call `search_files` — do not read files one by one');
    expect(prompt).not.toContain('call `grep_files` — do not read files one by one');
  });
});

describe('buildInstructions never advertises a tool the role lacks', () => {
  // Both of these fired as `directive-missing-tool` warnings against a
  // real Chief Security Officer session: the prompt told them to use
  // `run_playwright_script` and `search_code`, neither of which was on
  // their post-allowlist roster. Prose that names a tool the model
  // cannot call is the drift ADR 0001 exists to prevent.
  function prompt(names: string[], extra: Record<string, unknown> = {}): string {
    return buildInstructions({
      name: 'Kiran',
      role: 'Chief Security Officer',
      about: 'Audit the stack.',
      executionDensity: 'flat',
      availableTools: names.map((name) => ({ name, description: `${name} tool` })),
      ...extra,
    } as unknown as BuildInstructionsOptions).full;
  }

  it('drops the scripted-browsing directive when the role cannot run scripts', () => {
    const installed = { installedToolsetIds: new Set(['@playwright/mcp']) };
    const withScript = prompt(['run_playwright_script', 'write_artifact'], installed);
    expect(withScript).toContain('`run_playwright_script`');

    // Toolset installed, but the tool is not on this role's roster.
    const withoutScript = prompt(['read_file', 'validate'], installed);
    expect(withoutScript).not.toContain('run_playwright_script');
    expect(withoutScript).toContain('browser_*');
    expect(withoutScript).toContain('validate({ path: "index.html" })');
    expect(withoutScript).toContain('file:///workspace/index.html');
    expect(withoutScript).toContain('automatically rewrites');
  });

  it('does not advertise bridge-only file URL rewriting to Copilot', () => {
    const installed = { installedToolsetIds: new Set(['@playwright/mcp']) };
    const copilot = prompt(['read_file', 'validate', 'browser_navigate'], {
      ...installed,
      providerName: 'copilot',
    });
    expect(copilot).not.toContain('file:///workspace/index.html');
    expect(copilot).toContain('native MCP loop cannot rewrite `file:` navigation');
    expect(copilot).toContain('validate({ path: "index.html" })');
  });

  it('names only the GitHub tools the role actually holds', () => {
    const project = {
      id: 'p1',
      name: 'gezel',
      github: { url: 'https://github.com/bendyline/gezel' },
    } as unknown as ProjectDetail;
    const partial = prompt(['get_pull_request', 'get_issue'], { project });
    expect(partial).toContain('`get_pull_request`');
    expect(partial).not.toContain('search_code');

    // The first-party PR builtins are named too. They used to be missing
    // from the probe list, so a project holding them always fell through
    // to a blanket "the `github_*` tools on your function schema".
    const builtin = prompt(['github_pr_diff', 'github_pr_files'], { project });
    expect(builtin).toContain('`github_pr_diff`');

    // A third-party toolset's tool names only exist after its bridge
    // spawns, so with one INSTALLED an empty intersection means "can't
    // confirm" — the directive stands, it just names no specific tool.
    const unconfirmable = prompt(['read_file'], {
      project,
      installedToolsetIds: new Set(['github']),
    });
    expect(unconfirmable).toContain('Use the GitHub toolset');
    expect(unconfirmable).not.toContain('get_pull_request');

    // With no GitHub toolset installed, an empty intersection IS absence.
    // Promising tools here is what taught a PR-review step to call
    // `github_pr_diff` from a roster it had been stripped from.
    const none = prompt(['read_file'], { project });
    expect(none).toContain('This project is linked to');
    expect(none).not.toContain('Use the GitHub toolset');
    expect(none).not.toContain('github_*');
  });

  it('names only wired delegation tools in workspace guidance', () => {
    const project = { id: 'default', name: 'Default' } as unknown as ProjectDetail;
    const onlyMessage = buildInstructions({
      name: 'Wren',
      role: 'Meester',
      about: 'Route work to a specialist.',
      project,
      executionDensity: 'flat',
      workspaceFiles: [{ path: 'brief.md', isDirectory: false }],
      availableTools: [{ name: 'message_gezel', description: 'Send a handoff.' }],
    } as unknown as BuildInstructionsOptions).full;

    expect(onlyMessage).toContain('Delegate with `message_gezel`');
    expect(onlyMessage).not.toContain('`ensure_gezel`');
    expect(onlyMessage).not.toContain('`create_task`');
    expect(onlyMessage).not.toContain('`assign_task`');

    const none = buildInstructions({
      name: 'Wren',
      role: 'Meester',
      about: 'Route work to a specialist.',
      project,
      executionDensity: 'flat',
      workspaceFiles: [{ path: 'brief.md', isDirectory: false }],
      availableTools: [],
    } as unknown as BuildInstructionsOptions).full;
    expect(none).toContain('No delegation tool is wired this turn');
    expect(none).not.toContain('`message_gezel`');
    expect(none).not.toContain('`create_task`');
    expect(none).not.toContain('`assign_task`');
  });

  it('teaches ranged and batched reads only when those tools are wired', () => {
    const project = { id: 'default', name: 'Default' } as unknown as ProjectDetail;
    const render = (names: string[]) =>
      buildInstructions({
        name: 'Ada',
        role: 'Developer',
        about: 'Work on the project.',
        project,
        executionDensity: 'flat',
        workspaceFiles: [{ path: 'src/app.ts', isDirectory: false }],
        availableTools: names.map((name) => ({ name, description: `${name} tool` })),
      } as unknown as BuildInstructionsOptions).full;

    const full = render(['read_file', 'read_files', 'grep_files', 'write_file']);
    expect(full).toContain('use `read_file` with `{ path, startLine, endLine }`');
    expect(full).toContain('and `read_files` for several independent known paths/ranges');
    expect(full).toContain('use `grep_files` first when the location is unknown');

    const singular = render(['read_file', 'write_file']);
    expect(singular).toContain('use `read_file` with `{ path, startLine, endLine }`');
    expect(singular).not.toContain('and `read_files` for several independent known paths/ranges');
    expect(singular).not.toContain('use `grep_files` first when the location is unknown');
  });

  it('does not advertise unavailable shared-document tools', () => {
    const project = { id: 'default', name: 'Default' } as unknown as ProjectDetail;
    const rendered = buildInstructions({
      name: 'Wren',
      role: 'Meester',
      about: 'Route work to a specialist.',
      project,
      executionDensity: 'flat',
      documentFiles: [{ path: 'guidelines.md', isDirectory: false }],
      availableTools: [{ name: 'message_gezel', description: 'Send a handoff.' }],
    } as unknown as BuildInstructionsOptions).full;

    expect(rendered).toContain('No shared-document tool is wired this turn');
    expect(rendered).not.toContain('`list_documents`');
    expect(rendered).not.toContain('`read_document`');
    expect(rendered).not.toContain('`write_document`');
  });
});

describe('buildInstructions connected data', () => {
  const base = {
    id: 'p1',
    name: 'Ops',
  } as unknown as ProjectDetail;

  it('names each binding corpus, and is absent without bindings (cache stability)', () => {
    const withBindings = buildInstructions({
      name: 'Wren',
      about: 'Help with general work.',
      project: {
        ...base,
        connectors: [
          {
            id: 'mail-gmail:abc',
            type: 'mail-gmail',
            displayName: 'Work Gmail',
            corpusDir: 'data/work-gmail',
            config: {},
            lastSyncedAt: '2026-08-08T10:00:00.000Z',
          },
          {
            id: 'linear-issues:def',
            type: 'linear-issues',
            corpusDir: 'data/linear-issues',
            config: {},
            disabled: true,
          },
        ],
      } as unknown as ProjectDetail,
    }).full;
    expect(withBindings).toContain('### Connected data');
    expect(withBindings).toContain(
      '**Work Gmail** (mail-gmail, synced 2026-08-08): `artifacts/data/work-gmail/`',
    );
    expect(withBindings).not.toContain('linear-issues'); // disabled bindings hidden
    expect(withBindings).toContain('read-only mirrors');
    expect(withBindings).toContain('Use the artifact listing/reading tools');

    const without = buildInstructions({
      name: 'Wren',
      about: 'Help with general work.',
      project: base,
    }).full;
    expect(without).not.toContain('Connected data');
  });
});

describe('buildInstructions linked projects', () => {
  it('teaches the existing search and workspace tools the one-way virtual namespace', () => {
    const { full } = buildInstructions({
      name: 'Wren',
      about: 'Improve the vehicle simulation.',
      project: {
        id: 'racing-game',
        name: 'Racing game',
        linkedProjectIds: ['vehicle-physics', 'shared-renderer'],
      } as unknown as ProjectDetail,
    });

    expect(full).toContain('### Linked projects');
    expect(full).toContain('`../vehicle-physics/`');
    expect(full).toContain('`../shared-renderer/`');
    expect(full).toContain('The `search` tool already includes their indexed knowledge');
    expect(full).toContain('Links are direct, not transitive');
    expect(full).toContain("linked project's own workspace-write setting");
    expect(full).toContain('shared document library is also searched automatically');
  });

  it('omits the stable prompt block when no project links are configured', () => {
    const { full } = buildInstructions({
      name: 'Wren',
      about: 'Improve the vehicle simulation.',
      project: { id: 'racing-game', name: 'Racing game' } as unknown as ProjectDetail,
    });

    expect(full).not.toContain('### Linked projects');
  });
});

describe('buildInstructions structured step inputs', () => {
  it('renders artifact provenance and makes read_artifact the first small-model action', () => {
    const step = {
      id: 'audit',
      name: 'Audit controls',
      prompt: 'Write findings with `write_artifact`, then re-read them with `read_artifact`.',
      consumes: [{ file: 'security/review-scope.md', artifact: true }],
      createdAt: '2026-08-13T00:00:00.000Z',
    };
    const rendered = buildInstructions({
      name: 'Ebere',
      role: 'Application Security Engineer',
      about: 'Audit the project.',
      project: { id: 'gezel', name: 'Gezel' } as unknown as ProjectDetail,
      localModelTier: 'small',
      availableTools: ['read_file', 'read_artifact', 'write_artifact', 'advance_task_step'].map(
        (name) => ({ name, description: `${name} tool` }),
      ),
      task: {
        task: {
          ref: 'gezel/1',
          title: 'Security Architecture Review',
          status: 'active',
          assignee: { kind: 'gezel', gezelId: 'ebere' },
          craftbook: { steps: [step], entryStepId: 'audit' },
        },
        step,
      },
    } as unknown as BuildInstructionsOptions).full;

    expect(rendered).toContain('#### Required inputs');
    expect(rendered).toContain(
      '`security/review-scope.md` — required input in the **artifacts drawer**',
    );
    expect(rendered).toContain(
      '`read_artifact({ path: "security/review-scope.md" })`; do not try the other drawer',
    );
    expect(rendered).toContain(
      'First action (once only): call `read_artifact` exactly as the procedure specifies.',
    );
    expect(rendered).toContain(
      'After its successful tool result appears in this turn, treat that first action as complete',
    );
    expect(rendered).not.toContain(
      'First action (once only): call `write_artifact` exactly as the procedure specifies.',
    );
  });

  it('surfaces a missing drawer read capability without calling the input missing', () => {
    const step = {
      id: 'audit',
      name: 'Audit controls',
      prompt: 'First call `read_artifact({ path: "security/review-scope.md" })`.',
      consumes: [{ file: 'security/review-scope.md', artifact: true }],
      createdAt: '2026-08-13T00:00:00.000Z',
    };
    const rendered = buildInstructions({
      name: 'Ebere',
      role: 'Application Security Engineer',
      about: 'Audit the project.',
      project: { id: 'gezel', name: 'Gezel' } as unknown as ProjectDetail,
      localModelTier: 'small',
      availableTools: [{ name: 'read_file', description: 'workspace reader' }],
      task: {
        task: {
          ref: 'gezel/1',
          title: 'Security Architecture Review',
          status: 'active',
          assignee: { kind: 'gezel', gezelId: 'ebere' },
          craftbook: { steps: [step], entryStepId: 'audit' },
        },
        step,
      },
    } as unknown as BuildInstructionsOptions).full;

    expect(rendered).toContain('`read_artifact` is not wired this turn');
    expect(rendered).toContain('Do not claim it is missing');
  });

  // The powerpoint-deck wild catch: step 0's conditional escape hatch
  // ("If … are all empty, call `ask_user_question` and stop") was lifted
  // into the anchor as an unconditional command even though the topic
  // parameter was supplied.
  it('skips conditional and negated tool mentions when picking the first action', () => {
    const step = {
      id: 'research',
      name: 'Acquire and verify sources',
      prompt:
        'Topic: `startup ideas`. 0. If source path, topic, and inline content are all empty, call `ask_user_question` for the missing subject and stop. Do not call `read_task_notes` while the boundary is missing. 3. Call `write_task_note` with the sources used.',
      createdAt: '2026-08-26T00:00:00.000Z',
    };
    const rendered = buildInstructions({
      name: 'Agathe',
      role: 'Researcher',
      about: 'Research things.',
      project: { id: 'default', name: 'Default' } as unknown as ProjectDetail,
      localModelTier: 'small',
      availableTools: ['ask_user_question', 'read_task_notes', 'write_task_note'].map((name) => ({
        name,
        description: `${name} tool`,
      })),
      task: {
        task: {
          ref: 'default/8',
          title: 'PowerPoint from Content',
          status: 'active',
          assignee: { kind: 'gezel', gezelId: 'agathe' },
          craftbook: { steps: [step], entryStepId: 'research' },
        },
        step,
      },
    } as unknown as BuildInstructionsOptions).full;

    expect(rendered).toContain(
      'First action (once only): call `write_task_note` exactly as the procedure specifies.',
    );
    expect(rendered).not.toContain(
      'First action (once only): call `ask_user_question` exactly as the procedure specifies.',
    );
  });

  it('omits the first-action anchor entirely on a gate retry attempt', () => {
    const step = {
      id: 'research',
      name: 'Acquire and verify sources',
      prompt: 'Call `write_task_note` with the sources used.',
      attemptCount: 2,
      createdAt: '2026-08-26T00:00:00.000Z',
    };
    const rendered = buildInstructions({
      name: 'Agathe',
      role: 'Researcher',
      about: 'Research things.',
      project: { id: 'default', name: 'Default' } as unknown as ProjectDetail,
      localModelTier: 'small',
      availableTools: [{ name: 'write_task_note', description: 'note tool' }],
      task: {
        task: {
          ref: 'default/8',
          title: 'PowerPoint from Content',
          status: 'active',
          assignee: { kind: 'gezel', gezelId: 'agathe' },
          craftbook: { steps: [step], entryStepId: 'research' },
        },
        step,
      },
    } as unknown as BuildInstructionsOptions).full;

    expect(rendered).not.toContain('First action (once only)');
  });
});

describe('buildInstructions assigned pronouns', () => {
  const soloProject = {
    id: 'solo-job',
    name: 'Solo job',
    mode: 'solo',
  } as unknown as ProjectDetail;

  it.each([
    ['male', 'he/him', 'he will handle the project himself'],
    ['female', 'she/her', 'she will handle the project herself'],
    ['non-binary', 'they/them', 'they will handle the project themselves'],
  ] as const)('uses %s voorman pronouns in solo-project context', (gender, label, sentence) => {
    const { full } = buildInstructions({
      name: 'Worker',
      about: 'A worker.',
      project: soloProject,
      voormanName: 'Lyudmyla',
      voormanGender: gender,
    });

    expect(full).toContain(`Lyudmyla** (${label})`);
    expect(full).toContain(sentence);
  });
});

describe('buildInstructions active gezel identity', () => {
  it('renders the role without the active gezel name or pronouns', () => {
    const { full } = buildInstructions({
      name: 'Wren',
      role: 'Developer',
      about: 'Build reliable software.',
    });

    expect(full).toContain('Your role is "Developer".');
    expect(full).not.toContain('Wren');
    expect(full).not.toContain('Pronouns:');
  });

  it('uses a neutral gezel header when no role is configured', () => {
    const { full } = buildInstructions({ name: 'Wren', about: 'Help with general work.' });

    expect(full).toContain('You are a gezel.');
    expect(full).not.toContain('Wren');
  });

  it('describes an active project lead in second person without repeating their identity', () => {
    const project = {
      id: 'wren-project',
      name: 'Workshop',
      mode: 'crew',
      voormanGezelId: 'wren',
    } as unknown as ProjectDetail;
    const { full } = buildInstructions({
      name: 'Wren',
      gezelId: 'wren',
      role: 'Developer',
      about: 'Build reliable software.',
      project,
      voormanName: 'Wren',
      voormanGender: 'male',
    });

    expect(full).toContain('You are the voorman of this project.');
    expect(full).toContain('Do not ask the user to escalate work to the voorman — that is you.');
    expect(full).not.toContain('Wren');
    expect(full).not.toContain('(he/him)');
  });
});

describe('buildInstructions boring mode (roleBasedNameOnlyMode)', () => {
  const crewProject = {
    id: 'workshop',
    name: 'Workshop',
    mode: 'crew',
    voormanGezelId: 'tomas',
  } as unknown as ProjectDetail;

  it('renders the voorman by role-based name and states the naming rule', () => {
    const { full } = buildInstructions({
      name: 'Abby',
      role: 'Reviewer',
      about: 'Review the work.',
      roleBasedNameOnlyMode: true,
      project: crewProject,
      voormanName: 'Tomas',
      voormanRoleBasedName: 'voorman',
      voormanGender: 'male',
    });

    expect(full).toContain('by role name only');
    expect(full).toContain('**voorman**');
    // The friendly name must not appear anywhere — a single leak teaches
    // the model an identifier the boring-mode client never displays.
    expect(full).not.toContain('Tomas');
  });

  it('keeps friendly names and omits the naming rule when off', () => {
    const { full } = buildInstructions({
      name: 'Abby',
      role: 'Reviewer',
      about: 'Review the work.',
      project: crewProject,
      voormanName: 'Tomas',
      voormanRoleBasedName: 'voorman',
    });

    expect(full).not.toContain('by role name only');
    expect(full).toContain('**Tomas**');
  });
});

describe('buildInstructions workspace inventory', () => {
  it('renders explicit full-path file/dir rows instead of visually nesting root files', () => {
    const project = { id: 'default', name: 'Default' } as unknown as ProjectDetail;
    const { full } = buildInstructions({
      name: 'Reviewer',
      about: 'Review the deck.',
      project,
      workspaceFiles: [
        { name: 'assets', path: 'assets', isDirectory: true },
        { name: 'deck.md', path: 'deck.md', isDirectory: false },
        { name: 'generated', path: 'assets/generated', isDirectory: true },
        { name: 'map.png', path: 'assets/generated/map.png', isDirectory: false },
      ],
    });
    expect(full).toContain('dir  assets/');
    expect(full).toContain('file deck.md');
    expect(full).toContain('dir  assets/generated/');
    expect(full).toContain('file assets/generated/map.png');
    expect(full).not.toContain('📁 assets');
  });

  it('teaches incremental persistence only when a persistence tool is wired', () => {
    // Reading more than fits is routine; the shape that loops is
    // "read everything, then write once". The advice is useless — worse,
    // it prescribes a tool that does not exist — on a roster that cannot
    // persist, which is the ADR 0001 failure mode.
    const project = { id: 'default', name: 'Default' } as unknown as ProjectDetail;
    const base = { name: 'Reviewer', about: 'Review the corpus.', project };

    const withPersistence = buildInstructions({
      ...base,
      availableTools: [
        { name: 'read_file', description: 'Read a file.' },
        { name: 'write_task_note', description: 'Append a task note.' },
      ],
    } as unknown as Parameters<typeof buildInstructions>[0]).full;
    expect(withPersistence).toContain('larger than you can hold at once');
    expect(withPersistence).toContain('write_task_note');

    const readOnly = buildInstructions({
      ...base,
      availableTools: [{ name: 'read_file', description: 'Read a file.' }],
    } as unknown as Parameters<typeof buildInstructions>[0]).full;
    expect(readOnly).not.toContain('larger than you can hold at once');
  });
});
