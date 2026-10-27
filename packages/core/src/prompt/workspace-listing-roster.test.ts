/**
 * The workspace listing is drawn only for a turn whose roster can act on it.
 * A workflow step wired just for the artifacts drawer and `advance_task_step`
 * gets no listing; a turn that can read, write or delegate keeps it.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectDetail } from '../schemas/project.js';
import { buildInstructions } from './instructions.js';

const tool = (name: string) => ({ name, description: '' });

describe('workspace listing and the roster', () => {
  const base = {
    name: 'Reviewer',
    role: 'Reviewer',
    about: 'You review media.',
    project: { id: 'p', name: 'Project', about: 'A project.' } as ProjectDetail,
    providerName: 'codex-cli' as const,
    workspaceFiles: [
      { name: 'README.md', path: 'README.md', isDirectory: false },
      { name: 'catalog', path: 'catalog', isDirectory: true },
    ],
    assignedTasks: [],
  };

  it('leaves the listing out when no tool can act on workspace files', () => {
    const built = buildInstructions({
      ...base,
      availableTools: ['read_artifact', 'write_artifact', 'advance_task_step'].map(tool),
    });
    expect(built.full).not.toContain('### Workspace files');
    expect(built.full).not.toContain('file README.md');
    expect(built.full).toContain('Workspace files are not preloaded for this role');
  });

  it('keeps the listing for a turn that can read or delegate, and for an unknown roster', () => {
    for (const availableTools of [
      ['read_artifact', 'read_file'].map(tool),
      ['write_artifact', 'message_gezel'].map(tool),
      ['mcp__gezel__read_file'].map(tool),
      undefined,
    ]) {
      const built = buildInstructions({ ...base, ...(availableTools ? { availableTools } : {}) });
      expect(built.full).toContain('### Workspace files');
      expect(built.full).toContain('file README.md');
    }
  });
});
