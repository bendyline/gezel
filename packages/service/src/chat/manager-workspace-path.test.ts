import type { ProjectDetail } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { buildInstructions } from './instructions.js';

/**
 * Regression: an external-`workingDir` project must NOT leak its host
 * path into the system prompt. Showing it invited absolute-path tool
 * calls the containment layer rejected as an indistinguishable "missing"
 * (a real incident with a private client repo) and put a real user path
 * into transcripts / eval reports. The prompt should instead steer the
 * model to workspace-relative addressing.
 */
describe('buildInstructions — external workingDir path concealment', () => {
  const workingDir = '/Users/dev/gh/client-project';
  const project = {
    id: 'client',
    name: 'client-project',
    mode: 'scaffold',
    workingDir,
  } as unknown as ProjectDetail;

  it('does not print the absolute workingDir path', () => {
    const { full } = buildInstructions({ name: 'Reviewer', about: 'A reviewer.', project });
    expect(full).not.toContain(workingDir);
  });

  it('steers the model to workspace-relative addressing', () => {
    const { full } = buildInstructions({ name: 'Reviewer', about: 'A reviewer.', project });
    expect(full).toMatch(/relative to the workspace root/);
    expect(full).toMatch(/never by absolute path/);
  });
});
