import { describe, expect, it } from 'vitest';
import { findFlexibleMatch } from '../workspace-edits.js';
import { type PortableToolActions, executePortableTool } from './product-tools.js';
import { portableFixture } from './test-files.js';

const actions = {} as PortableToolActions;
async function fixture() {
  const f = portableFixture();
  await f.store.ensureLayout();
  const gezel = await f.store.createGezel({ name: 'Edda', role: 'Developer' });
  const session = await f.store.createSession({ gezelId: gezel.id });
  const run = (name: string, args: Record<string, unknown>) =>
    executePortableTool(f.store, session, name, args, actions);
  return { ...f, session, run };
}

describe('shared surgical file edits on the foreground host', () => {
  it('keeps concurrent appends in one serialized read-modify-write transaction', async () => {
    const f = await fixture();
    await f.store.writeFile('workspace', 'default', 'long.md', 'Original\n');
    await Promise.all([
      f.run('append_to_file', { path: 'long.md', content: 'First\n' }),
      f.run('append_to_file', { path: 'long.md', content: 'Second\n' }),
    ]);
    expect(await f.store.readFile('workspace', 'default', 'long.md')).toBe(
      'Original\nFirst\nSecond\n',
    );
  });

  it('requires explicit create and never converts a failed read into a new file', async () => {
    const f = await fixture();
    await expect(
      f.run('append_to_file', { path: 'new.md', content: 'text' }),
    ).rejects.toMatchObject({ code: 'file-not-found' });
    await f.run('append_to_file', { path: 'new.md', content: 'first', create: true });
    f.files.fault = (operation, path) => operation === 'read' && path.endsWith('/new.md');
    await expect(
      f.run('append_to_file', { path: 'new.md', content: 'second', create: true }),
    ).rejects.toThrow('Disk unavailable');
    f.files.fault = undefined;
    expect(await f.store.readFile('workspace', 'default', 'new.md')).toBe('first');
  });

  it('shares exact ambiguity, occurrence, whitespace fallback and line-ending behavior with desktop', async () => {
    const f = await fixture();
    await f.store.writeFile(
      'workspace',
      'default',
      'source.ts',
      'const x = 1;\r\n  return x;\r\nconst x = 1;\r\n',
    );
    await expect(
      f.run('replace_in_file', {
        path: 'source.ts',
        find: 'const x = 1;',
        replace: 'const x = 2;',
      }),
    ).rejects.toMatchObject({ code: 'ambiguous-match' });
    await f.run('replace_in_file', {
      path: 'source.ts',
      find: 'const x = 1;',
      replace: 'const x = 2;',
      occurrence: 2,
    });
    await f.run('replace_in_file', {
      path: 'source.ts',
      find: '2→ return   x;',
      replace: '  return x + 1;',
    });
    await f.run('replace_lines', {
      path: 'source.ts',
      startLine: 3,
      endLine: 3,
      content: '// unchanged tail\nconst y = 2;',
    });
    expect(await f.store.readFile('workspace', 'default', 'source.ts')).toBe(
      'const x = 1;\r\n  return x + 1;\r\n// unchanged tail\r\nconst y = 2;\r\n',
    );
  });

  it.each(['append_to_file', 'replace_in_file', 'replace_lines'])(
    'denies %s under role, step, path and project authority',
    async (name) => {
      const f = await fixture();
      const args = {
        path: 'source.ts',
        content: 'new',
        find: 'old',
        replace: 'new',
        startLine: 1,
        endLine: 1,
      };
      const body =
        name === 'append_to_file'
          ? { path: args.path, content: args.content }
          : name === 'replace_in_file'
            ? { path: args.path, find: args.find, replace: args.replace }
            : { path: args.path, startLine: 1, endLine: 1, content: args.content };
      await f.store.writeFile('workspace', 'default', args.path, 'old');
      await expect(f.run(name, { ...body, path: '../outside.ts' })).rejects.toThrow();
      await f.store.updateProject('default', { status: 'readonly' });
      await expect(f.run(name, body)).rejects.toThrow('read-only');
      await f.store.updateProject('default', { status: 'active' });
      const coordinator = await f.store.createGezel({ name: 'Lead', role: 'Voorman' });
      await expect(
        executePortableTool(
          f.store,
          { ...f.session, gezelId: coordinator.id },
          name,
          body,
          actions,
        ),
      ).rejects.toThrow('unavailable');
      const task = await f.store.createTask('default', {
        title: 'Read',
        description: 'Inspect existing source without changing it.',
        steps: [
          { name: 'Inspect', prompt: 'Read source', toolPolicy: { allowTools: ['read_file'] } },
        ],
      });
      await expect(
        executePortableTool(
          f.store,
          { ...f.session, taskRef: task.ref, stepId: task.activeStepId },
          name,
          body,
          actions,
        ),
      ).rejects.toThrow('unavailable');
      expect(await f.store.readFile('workspace', 'default', args.path)).toBe('old');
    },
  );

  it('counts overlapping normalized matches and handles long repetitive input without nested scans', () => {
    expect(findFlexibleMatch(' x\nx\nx ', 'x\nx')).toEqual({ kind: 'ambiguous', count: 2 });
    const source = `${'repeat\n'.repeat(30_000)}finish\n`;
    const needle = `${' repeat \n'.repeat(15_000)}finish`;
    expect(findFlexibleMatch(source, needle)).toEqual({
      kind: 'range',
      start: 15_000 * 7,
      end: source.length - 1,
    });
  });
});
