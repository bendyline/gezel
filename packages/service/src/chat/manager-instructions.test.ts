import type { ProjectDetail } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { type BuildInstructionsOptions, buildInstructions } from './manager.js';

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
    expect(prompt).toContain('first call `suggest_craftbook`');
    expect(prompt).toContain('PowerPoint/PPTX');
    expect(prompt).toContain('Word/DOCX');
    expect(prompt).toContain('MP4, GIF');
    expect(prompt).toContain('do not silently substitute markdown');
    expect(prompt).toContain('author Markdown');
    expect(prompt).toContain('Do not recruit a developer');
    expect(prompt).toContain('`convert_document`');
    expect(prompt).toContain('`save_artifact`');
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
    const withoutScript = prompt(['read_file'], installed);
    expect(withoutScript).not.toContain('run_playwright_script');
    expect(withoutScript).toContain('browser_*');
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

    // These names come from an installed third-party toolset, so an
    // empty intersection means "can't confirm", not "absent" — the
    // directive stands, it just stops naming specific tools.
    const none = prompt(['read_file'], { project });
    expect(none).toContain('Use the GitHub toolset');
    expect(none).not.toContain('search_code');
    expect(none).not.toContain('get_pull_request');
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

describe('buildInstructions assigned pronouns', () => {
  const soloProject = {
    id: 'solo-job',
    name: 'Solo job',
    mode: 'solo',
  } as unknown as ProjectDetail;

  it.each([
    ['male', 'he/him', 'he will handle the entire project himself'],
    ['female', 'she/her', 'she will handle the entire project herself'],
    ['non-binary', 'they/them', 'they will handle the entire project themselves'],
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
