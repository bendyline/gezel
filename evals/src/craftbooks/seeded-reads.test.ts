import { describe, expect, it } from 'vitest';
import { __testing } from './scenario.ts';

const { sessionReadPaths } = __testing;

/**
 * The seeded-source-read check must agree with what each provider actually
 * calls, or it makes scenarios unwinnable by construction — and an
 * unwinnable scenario books as a `model` failure, which is the worst
 * possible outcome for a scorecard.
 *
 * Wild-caught on the first frontier ceiling run of the `developer` suite:
 * claude-sonnet-4-6 opened all four seeded files, wrote a flawless security
 * review, and sat at 9/11 on "seeded workspace input(s) have not been read
 * yet" — because it used its built-in `Read` and the check only recognized
 * gezel-mcp's `read_file`, which `CLAUDE_CLI_EXCLUDED_MCP_TOOLS` removes on
 * purpose. The fixtures below are the shapes taken verbatim from that trial.
 */

const SEEDED = ['src/admin.ts', 'src/profile.ts', 'docs/security.md'];

/** Verbatim shape of a Claude CLI built-in read: absolute path, in `argsFull`. */
const claudeRead = (absPath: string) => ({
  name: 'Read',
  success: true,
  argsSummary: `file_path: "${absPath.slice(0, 40)}…"`,
  argsFull: `file_path:\n${absPath}`,
});

const ROOT = '/private/var/folders/wp/T/gezel-eval-x/projects/p/workspace';

describe('seeded source reads', () => {
  it('counts gezel-mcp read_file with a workspace-relative path', () => {
    const session = {
      id: 's1',
      messages: [{ toolCalls: [{ name: 'read_file', success: true, path: 'src/admin.ts' }] }],
    };
    expect([...sessionReadPaths(session, SEEDED)]).toEqual(['src/admin.ts']);
  });

  it('counts the same tool namespaced by a CLI provider', () => {
    const session = {
      id: 's1',
      messages: [
        { toolCalls: [{ name: 'mcp__gezel__read_file', success: true, path: 'src/profile.ts' }] },
      ],
    };
    expect([...sessionReadPaths(session, SEEDED)]).toEqual(['src/profile.ts']);
  });

  it("counts Claude's built-in Read, whose path is absolute and lives in argsFull", () => {
    const session = {
      id: 's1',
      messages: [
        { toolCalls: [claudeRead(`${ROOT}/src/admin.ts`)] },
        { toolCalls: [claudeRead(`${ROOT}/docs/security.md`)] },
      ],
    };
    expect([...sessionReadPaths(session, SEEDED)].sort()).toEqual([
      'docs/security.md',
      'src/admin.ts',
    ]);
  });

  it('ignores a failed read', () => {
    const session = {
      id: 's1',
      messages: [{ toolCalls: [{ ...claudeRead(`${ROOT}/src/admin.ts`), success: false }] }],
    };
    expect([...sessionReadPaths(session, SEEDED)]).toEqual([]);
  });

  // Grep proves a file matched a pattern, not that its contents were taken
  // in; a shell tool's argument text is unbounded, so a path inside it could
  // be a write or a mention. Counting either would hollow out the check.
  it.each(['Grep', 'Glob', 'run_nodejs_script', 'write_file'])(
    'does not count %s as a read',
    (name) => {
      const session = {
        id: 's1',
        messages: [
          { toolCalls: [{ name, success: true, argsFull: `path:\n${ROOT}/src/admin.ts` }] },
        ],
      };
      expect([...sessionReadPaths(session, SEEDED)]).toEqual([]);
    },
  );
});
