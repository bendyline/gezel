import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A source-level wiring check, not a behavior test — the logic itself is
 * covered by core's `task-owned-paths.test.ts`.
 *
 * `taskScopedWriteRefusal` is the complement of `staleStepMutationResult`:
 * one polices a bound session writing outside its own step, the other an
 * unbound session writing into a live task's folder. Together they cover
 * every writer. A new mutation tool that picks up only the first guard
 * reopens the hole that destroyed a finished deck, and nothing at runtime
 * would say so — the write simply succeeds.
 */
const source = readFileSync(fileURLToPath(new URL('./server.ts', import.meta.url)), 'utf8');

/** Split the server into one chunk per `server.tool(...)` registration. */
function toolBlocks(): Array<{ name: string; body: string }> {
  const blocks: Array<{ name: string; body: string }> = [];
  for (const chunk of source.split('server.tool(').slice(1)) {
    const name = /^\s*'([a-z_]+)',/.exec(chunk)?.[1];
    if (name) blocks.push({ name, body: chunk });
  }
  return blocks;
}

describe('task-scoped write guard wiring', () => {
  const blocks = toolBlocks();

  it('finds the mutation tools it is supposed to be checking', () => {
    const guarded = blocks
      .filter((b) => b.body.includes('staleStepMutationResult()'))
      .map((b) => b.name);
    expect(guarded).toEqual(
      expect.arrayContaining(['write_file', 'write_artifact', 'replace_in_file', 'rename']),
    );
    expect(guarded.length).toBeGreaterThanOrEqual(11);
  });

  it('guards every step-gated mutation tool against unbound task-folder writes', () => {
    for (const block of blocks) {
      if (!block.body.includes('staleStepMutationResult()')) continue;
      expect(block.body, `${block.name} is missing taskScopedWriteRefusal`).toContain(
        'taskScopedWriteRefusal(',
      );
    }
  });

  it('checks the destination of every path a mutation can land on', () => {
    const expected: Record<string, string[]> = {
      // The artifacts drawer is its own path space; `tasks/<num>` there is
      // not `tasks/<num>` in the workspace.
      write_artifact: ["taskScopedWriteRefusal(path, 'artifacts')"],
      // `source` is a read; only the workspace destination is a write.
      copy_artifact_to_workspace: ["taskScopedWriteRefusal(dest, 'workspace')"],
      // Both ends: renaming a task's file away is as destructive as
      // clobbering it, and renaming onto one overwrites.
      rename: [
        "taskScopedWriteRefusal(fromPath, 'workspace')",
        "taskScopedWriteRefusal(toPath, 'workspace')",
      ],
    };
    for (const [name, calls] of Object.entries(expected)) {
      const block = blocks.find((b) => b.name === name);
      expect(block, `${name} tool not found`).toBeDefined();
      for (const call of calls) {
        expect(block?.body, `${name} should call ${call}`).toContain(call);
      }
    }
  });

  it('short-circuits for bound sessions before making any request', () => {
    const guard = source.slice(source.indexOf('async function taskScopedWriteRefusal'));
    const body = guard.slice(0, guard.indexOf('\n}\n'));
    // The ref check must precede the task listing, or every step write in a
    // craftbook pays an HTTP round trip it can never be refused by.
    expect(body.indexOf('if (sessionTaskRef) return null;')).toBeLessThan(
      body.indexOf('listProjectTasks'),
    );
  });
});
