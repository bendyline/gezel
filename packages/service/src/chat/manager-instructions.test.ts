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
    expect(full).not.toContain('Wren');
    expect(full).not.toContain('(he/him)');
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
});
