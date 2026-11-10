import { describe, expect, it } from 'vitest';
import { CLAUDE_CLI_EXCLUDED_MCP_TOOLS } from './excluded-mcp-tools.js';
import { CLAUDE_STAND_INS, claudeToolGuide, withClaudeToolGuide } from './tool-guide.js';

// What `claudeBuiltinsToDisallow` gives a role with only `workspace-fs-read`
// (a voorman) and a role with no workspace, code or web groups (the Meester).
const READ_ONLY_ROLE = ['Write', 'Edit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch'];
const DELEGATION_ROLE = [...READ_ONLY_ROLE, 'Read', 'Grep', 'Glob'];

describe('claudeToolGuide', () => {
  it('sends work for the hidden Gezel tools to Claude Code built-ins, but keeps the receipt runners', () => {
    const guide = claudeToolGuide({ permissionMode: 'acceptEdits' }) ?? '';
    expect(guide).toMatch(/^### Gezel tools in Claude Code\n\n/);
    expect(guide).toContain('`mcp__gezel__<tool>`');
    expect(guide).toContain('`read_file`, `read_files` and `read_image_as_base64` → `Read`');
    expect(guide).toContain('`grep_files` → `Grep`');
    expect(guide).toContain('`write_file` → `Write` or `Edit`');
    expect(guide).toContain('`run_nodejs_script`');
    expect(guide).toContain('`fetch_url` → `WebFetch`; `web_search` → `WebSearch`');
    expect(guide).toContain('not a blocker, so do not search for them');
    expect(guide).toContain(
      "Use `run_package_script` and `run_npx` where your instructions name them: the step's checks read their run records, which a `Bash` run does not leave.",
    );
  });

  it('names a stand-in for every tool hidden from Claude, and only those', () => {
    expect(Object.keys(CLAUDE_STAND_INS).sort()).toEqual([...CLAUDE_CLI_EXCLUDED_MCP_TOOLS].sort());
    const guide = claudeToolGuide({ permissionMode: 'acceptEdits' }) ?? '';
    for (const name of CLAUDE_CLI_EXCLUDED_MCP_TOOLS) expect(guide).toContain(`\`${name}\``);
  });

  it('names only the receipt runners this session was granted', () => {
    const granted = new Set(['read_file', 'write_file', 'run_package_script']);
    const guide = claudeToolGuide({ permissionMode: 'acceptEdits', toolAllowlist: granted }) ?? '';
    expect(guide).toContain('Use `run_package_script` where your instructions name them');
    expect(guide).not.toContain('`run_npx`');
    expect(guide).not.toContain('`fetch_url`');
    const withoutRunners = claudeToolGuide({
      permissionMode: 'acceptEdits',
      toolAllowlist: new Set(['read_file', 'write_file']),
    });
    expect(withoutRunners).not.toContain('run records');
  });

  it('does not tell a plan session to edit or run anything', () => {
    const guide = claudeToolGuide({ permissionMode: 'plan' }) ?? '';
    expect(guide).toContain('`read_file`, `read_files` and `read_image_as_base64` → `Read`');
    expect(guide).toContain('`fetch_url` → `WebFetch`');
    expect(guide).not.toContain('write_file');
    expect(guide).not.toContain('Bash');
    expect(guide).not.toContain('run records');
  });

  it("names no built-in the role's --disallowedTools takes away", () => {
    const guide =
      claudeToolGuide({ permissionMode: 'acceptEdits', disallowedBuiltinTools: READ_ONLY_ROLE }) ??
      '';
    expect(guide).toContain('`grep_files` → `Grep`');
    expect(guide).not.toContain('write_file');
    expect(guide).not.toContain('`fetch_url`');
    expect(guide).not.toContain('`Bash`');
    expect(guide).toContain('which a shell run does not leave');
  });

  it('does not route around a session Gezel withheld its writers from', () => {
    const readOnlyProject = new Set(['read_file', 'grep_files', 'run_nodejs_script']);
    const guide =
      claudeToolGuide({ permissionMode: 'acceptEdits', toolAllowlist: readOnlyProject }) ?? '';
    expect(guide).toContain('`read_file` → `Read`');
    expect(guide).not.toContain('write_file');
    expect(guide).not.toContain('`rename`');
  });

  it('leaves the writers unmapped while the task drafts a change proposal', () => {
    const guide = claudeToolGuide({ permissionMode: 'acceptEdits', drafting: true }) ?? '';
    expect(guide).toContain('`read_file`');
    expect(guide).toContain('`run_nodejs_script`');
    for (const writer of ['write_file', 'delete_path', 'make_dir', 'rename']) {
      expect(guide).not.toContain(`\`${writer}\``);
    }
  });

  it('leaves instructions alone when there is nothing to say', () => {
    const meester = {
      permissionMode: 'acceptEdits' as const,
      disallowedBuiltinTools: DELEGATION_ROLE,
      toolAllowlist: new Set(['list_gezels', 'start_project']),
    };
    expect(claudeToolGuide(meester)).toBeNull();
    expect(withClaudeToolGuide('Persona.', meester)).toBe('Persona.');
    expect(withClaudeToolGuide('Persona.\n', { permissionMode: 'acceptEdits' })).toMatch(
      /^Persona\.\n\n---\n\n### Gezel tools in Claude Code\n/,
    );
  });
});
