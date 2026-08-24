import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceEditError } from '../workspace/errors.js';
import { Store } from './store.js';

let home: string;
let store: Store;
const projectId = 'edit-fixture';

async function seedFile(rel: string, content: string): Promise<string> {
  const wd = await store.projectWorkspaceDir(projectId);
  const full = join(wd, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content, 'utf8');
  return full;
}

async function readBack(rel: string): Promise<string> {
  const wd = await store.projectWorkspaceDir(projectId);
  return readFile(join(wd, rel), 'utf8');
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-edit-store-test-'));
  store = new Store({ home });
  await store.ensureLayout();
  await mkdir(await store.projectWorkspaceDir(projectId), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('Store.replaceInProjectWorkspaceFile', () => {
  it('replaces a single matched occurrence and returns a unified diff', async () => {
    await seedFile('notes.md', 'hello world\nfoo bar\n');
    const result = await store.replaceInProjectWorkspaceFile(projectId, {
      path: 'notes.md',
      find: 'foo bar',
      replace: 'FOO BAR',
    });
    expect(await readBack('notes.md')).toBe('hello world\nFOO BAR\n');
    expect(result.path).toBe('notes.md');
    expect(result.addedLines).toBe(1);
    expect(result.removedLines).toBe(1);
    expect(result.diff).toContain('-foo bar');
    expect(result.diff).toContain('+FOO BAR');
  });

  it('rejects when the pattern is not found', async () => {
    await seedFile('notes.md', 'hello world\n');
    await expect(
      store.replaceInProjectWorkspaceFile(projectId, {
        path: 'notes.md',
        find: 'absent',
        replace: 'present',
      }),
    ).rejects.toMatchObject({ code: 'pattern-not-found' });
  });

  it("rejects when the pattern matches multiple places and occurrence isn't set", async () => {
    await seedFile('notes.md', 'cat cat cat\n');
    await expect(
      store.replaceInProjectWorkspaceFile(projectId, {
        path: 'notes.md',
        find: 'cat',
        replace: 'dog',
      }),
    ).rejects.toMatchObject({ code: 'ambiguous-match' });
  });

  it('replaces every occurrence when occurrence="all"', async () => {
    await seedFile('notes.md', 'cat cat cat\n');
    const result = await store.replaceInProjectWorkspaceFile(projectId, {
      path: 'notes.md',
      find: 'cat',
      replace: 'dog',
      occurrence: 'all',
    });
    expect(await readBack('notes.md')).toBe('dog dog dog\n');
    expect(result.addedLines).toBe(1);
    expect(result.removedLines).toBe(1);
  });

  it('targets a specific 1-based occurrence', async () => {
    await seedFile('notes.md', 'cat cat cat\n');
    await store.replaceInProjectWorkspaceFile(projectId, {
      path: 'notes.md',
      find: 'cat',
      replace: 'dog',
      occurrence: 2,
    });
    expect(await readBack('notes.md')).toBe('cat dog cat\n');
  });

  it('rejects when occurrence is out of range', async () => {
    await seedFile('notes.md', 'cat cat\n');
    await expect(
      store.replaceInProjectWorkspaceFile(projectId, {
        path: 'notes.md',
        find: 'cat',
        replace: 'dog',
        occurrence: 5,
      }),
    ).rejects.toMatchObject({ code: 'occurrence-out-of-range' });
  });

  it('rejects identity edits (find === replace) as a no-op', async () => {
    await seedFile('notes.md', 'hello\n');
    await expect(
      store.replaceInProjectWorkspaceFile(projectId, {
        path: 'notes.md',
        find: 'hello',
        replace: 'hello',
      }),
    ).rejects.toMatchObject({ code: 'identity-edit' });
  });

  it('rejects when the target file does not exist', async () => {
    await expect(
      store.replaceInProjectWorkspaceFile(projectId, {
        path: 'never-existed.md',
        find: 'x',
        replace: 'y',
      }),
    ).rejects.toMatchObject({ code: 'file-not-found' });
  });

  it('falls back to a whitespace-flexible match when exact spacing differs', async () => {
    // The file has two spaces inside the call; `find` uses one, so the
    // exact substring match fails and the fuzzy line match recovers,
    // replacing the whole line with the supplied (re-indented) content.
    await seedFile('app.js', 'function f() {\n        return  42;\n}\n');
    const result = await store.replaceInProjectWorkspaceFile(projectId, {
      path: 'app.js',
      find: 'return 42;',
      replace: '    return 43;',
    });
    expect(await readBack('app.js')).toBe('function f() {\n    return 43;\n}\n');
    expect(result.addedLines).toBe(1);
    expect(result.removedLines).toBe(1);
  });

  it('flexible fallback strips a pasted N→ line-number gutter', async () => {
    await seedFile('app.js', 'const a = 1;\nconst b = 2;\n');
    await store.replaceInProjectWorkspaceFile(projectId, {
      path: 'app.js',
      find: '2→const b = 2;',
      replace: 'const b = 20;',
    });
    expect(await readBack('app.js')).toBe('const a = 1;\nconst b = 20;\n');
  });

  it('flexible fallback reports ambiguity rather than guessing', async () => {
    // Double-spaced find has no exact match; normalized it matches both lines.
    await seedFile('app.txt', 'a b c\n  a b c\n');
    await expect(
      store.replaceInProjectWorkspaceFile(projectId, {
        path: 'app.txt',
        find: 'a  b  c',
        replace: 'x y z',
      }),
    ).rejects.toMatchObject({ code: 'ambiguous-match' });
  });
});

describe('Store.replaceLinesInProjectWorkspaceFile', () => {
  it('replaces a single line by number', async () => {
    await seedFile('app.js', 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    const result = await store.replaceLinesInProjectWorkspaceFile(projectId, {
      path: 'app.js',
      startLine: 2,
      endLine: 2,
      content: 'const b = 20;',
    });
    expect(await readBack('app.js')).toBe('const a = 1;\nconst b = 20;\nconst c = 3;\n');
    expect(result.addedLines).toBe(1);
    expect(result.removedLines).toBe(1);
  });

  it('replaces a multi-line range with multi-line content', async () => {
    await seedFile('app.js', 'a\nb\nc\nd\n');
    await store.replaceLinesInProjectWorkspaceFile(projectId, {
      path: 'app.js',
      startLine: 2,
      endLine: 3,
      content: 'B\nB2\nB3',
    });
    expect(await readBack('app.js')).toBe('a\nB\nB2\nB3\nd\n');
  });

  it('deletes a range when content is empty', async () => {
    await seedFile('app.js', 'a\nb\nc\n');
    await store.replaceLinesInProjectWorkspaceFile(projectId, {
      path: 'app.js',
      startLine: 2,
      endLine: 2,
      content: '',
    });
    expect(await readBack('app.js')).toBe('a\nc\n');
  });

  it('clamps endLine to the file length', async () => {
    await seedFile('app.js', 'a\nb\nc\n');
    await store.replaceLinesInProjectWorkspaceFile(projectId, {
      path: 'app.js',
      startLine: 2,
      endLine: 999,
      content: 'B',
    });
    expect(await readBack('app.js')).toBe('a\nB\n');
  });

  it('preserves CRLF line endings', async () => {
    await seedFile('app.js', 'a\r\nb\r\nc\r\n');
    await store.replaceLinesInProjectWorkspaceFile(projectId, {
      path: 'app.js',
      startLine: 2,
      endLine: 2,
      content: 'B',
    });
    expect(await readBack('app.js')).toBe('a\r\nB\r\nc\r\n');
  });

  it('handles a file with no trailing newline', async () => {
    await seedFile('app.js', 'a\nb\nc');
    await store.replaceLinesInProjectWorkspaceFile(projectId, {
      path: 'app.js',
      startLine: 3,
      endLine: 3,
      content: 'C',
    });
    expect(await readBack('app.js')).toBe('a\nb\nC');
  });

  it('rejects startLine past the end of file', async () => {
    await seedFile('app.js', 'a\nb\n');
    await expect(
      store.replaceLinesInProjectWorkspaceFile(projectId, {
        path: 'app.js',
        startLine: 9,
        endLine: 9,
        content: 'x',
      }),
    ).rejects.toMatchObject({ code: 'line-out-of-range' });
  });

  it('rejects endLine before startLine', async () => {
    await seedFile('app.js', 'a\nb\nc\n');
    await expect(
      store.replaceLinesInProjectWorkspaceFile(projectId, {
        path: 'app.js',
        startLine: 3,
        endLine: 1,
        content: 'x',
      }),
    ).rejects.toMatchObject({ code: 'invalid-range' });
  });

  it('rejects an identity edit', async () => {
    await seedFile('app.js', 'a\nb\nc\n');
    await expect(
      store.replaceLinesInProjectWorkspaceFile(projectId, {
        path: 'app.js',
        startLine: 2,
        endLine: 2,
        content: 'b',
      }),
    ).rejects.toMatchObject({ code: 'identity-edit' });
  });

  it('rejects when the file does not exist', async () => {
    await expect(
      store.replaceLinesInProjectWorkspaceFile(projectId, {
        path: 'nope.js',
        startLine: 1,
        endLine: 1,
        content: 'x',
      }),
    ).rejects.toMatchObject({ code: 'file-not-found' });
  });
});

describe('Store.applyPatchToProjectWorkspaceFile', () => {
  it('applies a single-file unified diff cleanly', async () => {
    const original = 'line one\nline two\nline three\n';
    await seedFile('notes.md', original);
    const diff = [
      '--- a/notes.md',
      '+++ b/notes.md',
      '@@ -1,3 +1,3 @@',
      ' line one',
      '-line two',
      '+LINE TWO',
      ' line three',
      '',
    ].join('\n');
    const result = await store.applyPatchToProjectWorkspaceFile(projectId, {
      path: 'notes.md',
      diff,
    });
    expect(await readBack('notes.md')).toBe('line one\nLINE TWO\nline three\n');
    expect(result.addedLines).toBe(1);
    expect(result.removedLines).toBe(1);
  });

  it('rejects when a hunk fails to apply (stale context)', async () => {
    await seedFile('notes.md', 'completely different content\n');
    const diff = [
      '--- a/notes.md',
      '+++ b/notes.md',
      '@@ -1,3 +1,3 @@',
      ' line one',
      '-line two',
      '+LINE TWO',
      ' line three',
      '',
    ].join('\n');
    await expect(
      store.applyPatchToProjectWorkspaceFile(projectId, { path: 'notes.md', diff }),
    ).rejects.toMatchObject({ code: 'patch-rejected' });
  });

  it('rejects multi-file diffs with a guidance error', async () => {
    await seedFile('a.txt', 'a\n');
    await seedFile('b.txt', 'b\n');
    const diff = [
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-a',
      '+A',
      '--- a/b.txt',
      '+++ b/b.txt',
      '@@ -1 +1 @@',
      '-b',
      '+B',
      '',
    ].join('\n');
    await expect(
      store.applyPatchToProjectWorkspaceFile(projectId, { path: 'a.txt', diff }),
    ).rejects.toMatchObject({ code: 'patch-multi-file' });
  });

  it('rejects an empty / unparseable diff', async () => {
    await seedFile('notes.md', 'x\n');
    await expect(
      store.applyPatchToProjectWorkspaceFile(projectId, {
        path: 'notes.md',
        diff: 'not-a-diff',
      }),
    ).rejects.toThrow(WorkspaceEditError);
  });

  it('rejects when the target file is missing', async () => {
    const diff = ['--- a/missing.md', '+++ b/missing.md', '@@ -1 +1 @@', '-old', '+new', ''].join(
      '\n',
    );
    await expect(
      store.applyPatchToProjectWorkspaceFile(projectId, { path: 'missing.md', diff }),
    ).rejects.toMatchObject({ code: 'file-not-found' });
  });
});

describe('Store.applyEditPackToProjectWorkspace', () => {
  const patchFor = (file: string, from: string, to: string) =>
    [`--- a/${file}`, `+++ b/${file}`, '@@ -1 +1 @@', `-${from}`, `+${to}`, ''].join('\n');

  it('applies every file when all patches validate, treating identity edits as no-ops', async () => {
    await seedFile('a.txt', 'a\n');
    await seedFile('b.txt', 'b\n');
    const result = await store.applyEditPackToProjectWorkspace(projectId, [
      { path: 'a.txt', diff: patchFor('a.txt', 'a', 'A') },
      // Already-applied change: old and new content are identical.
      { path: 'b.txt', diff: patchFor('b.txt', 'missing', 'b') },
    ]);
    // The b.txt patch actually rejects (context mismatch) — use a real no-op:
    expect(result.ok).toBe(false);

    await seedFile('c.txt', 'C\n');
    const ok = await store.applyEditPackToProjectWorkspace(projectId, [
      { path: 'a.txt', diff: patchFor('a.txt', 'a', 'A') },
      { path: 'c.txt', diff: patchFor('c.txt', 'C', 'C') },
    ]);
    expect(ok.ok).toBe(true);
    expect(ok.results).toEqual([
      { path: 'a.txt', ok: true },
      { path: 'c.txt', ok: true, error: 'no-op' },
    ]);
    expect(await readBack('a.txt')).toBe('A\n');
    expect(await readBack('c.txt')).toBe('C\n');
  });

  it('writes NOTHING when any patch in the pack fails validation', async () => {
    await seedFile('good.txt', 'good\n');
    await seedFile('stale.txt', 'unexpected content\n');
    const result = await store.applyEditPackToProjectWorkspace(projectId, [
      { path: 'good.txt', diff: patchFor('good.txt', 'good', 'GOOD') },
      { path: 'stale.txt', diff: patchFor('stale.txt', 'stale', 'STALE') },
    ]);
    expect(result.ok).toBe(false);
    expect(result.results.find((r) => r.path === 'good.txt')?.ok).toBe(true);
    expect(result.results.find((r) => r.path === 'stale.txt')?.ok).toBe(false);
    // Validate-all-first: the good file was NOT written.
    expect(await readBack('good.txt')).toBe('good\n');
    expect(await readBack('stale.txt')).toBe('unexpected content\n');
  });
});

describe('Store.insertAtMarkerInProjectWorkspaceFile', () => {
  it('inserts after the marker by default', async () => {
    await seedFile('src/index.ts', "// EXPORTS\nexport * from './a.js';\n");
    const result = await store.insertAtMarkerInProjectWorkspaceFile(projectId, {
      path: 'src/index.ts',
      marker: '// EXPORTS\n',
      content: "export * from './b.js';\n",
    });
    expect(await readBack('src/index.ts')).toBe(
      "// EXPORTS\nexport * from './b.js';\nexport * from './a.js';\n",
    );
    expect(result.addedLines).toBe(1);
  });

  it('inserts before the marker when where="before"', async () => {
    await seedFile('a.txt', 'middle\nend\n');
    await store.insertAtMarkerInProjectWorkspaceFile(projectId, {
      path: 'a.txt',
      marker: 'middle\n',
      content: 'start\n',
      where: 'before',
    });
    expect(await readBack('a.txt')).toBe('start\nmiddle\nend\n');
  });

  it('rejects when the marker is missing', async () => {
    await seedFile('a.txt', 'hello\n');
    await expect(
      store.insertAtMarkerInProjectWorkspaceFile(projectId, {
        path: 'a.txt',
        marker: 'absent',
        content: 'x',
      }),
    ).rejects.toMatchObject({ code: 'marker-not-found' });
  });

  it('rejects when the marker appears multiple times', async () => {
    await seedFile('a.txt', 'X\nbody\nX\n');
    await expect(
      store.insertAtMarkerInProjectWorkspaceFile(projectId, {
        path: 'a.txt',
        marker: 'X',
        content: 'y',
      }),
    ).rejects.toMatchObject({ code: 'marker-ambiguous' });
  });
});

describe('workspace tools tolerate an absolute path under the workspace', () => {
  // Belt-and-suspenders: the standing prompt conceals the workspace host
  // path, but a model that echoes an absolute path (from git output, an
  // error string, a user paste) should still land on the right file
  // instead of getting a bare "missing" (a real external-workspace incident).
  it('reads a file addressed by absolute path under the workspace', async () => {
    await seedFile('AGENTS.md', '# guide\n');
    const wd = await store.projectWorkspaceDir(projectId);
    const abs = join(wd, 'AGENTS.md');
    expect(await store.readProjectWorkspaceFile(projectId, abs)).toBe('# guide\n');
  });

  it('stats a file addressed by absolute path under the workspace', async () => {
    await seedFile('src/index.ts', 'export {}\n');
    const wd = await store.projectWorkspaceDir(projectId);
    const res = await store.statProjectWorkspacePath(projectId, join(wd, 'src', 'index.ts'));
    expect(res.kind).toBe('file');
  });

  it('writes a file addressed by absolute path under the workspace', async () => {
    const wd = await store.projectWorkspaceDir(projectId);
    await store.writeProjectWorkspaceFile(projectId, join(wd, 'out', 'note.md'), 'hi\n');
    expect(await readBack('out/note.md')).toBe('hi\n');
  });

  it('throws an actionable error for an absolute path outside the workspace', async () => {
    const outside = process.platform === 'win32' ? 'C:\\etc\\passwd' : '/etc/passwd';
    await expect(store.readProjectWorkspaceFile(projectId, outside)).rejects.toThrow(
      /outside the workspace/,
    );
    await expect(store.writeProjectWorkspaceFile(projectId, outside, 'x')).rejects.toThrow(
      /outside the workspace/,
    );
  });
});

describe('workspace writes refuse an unresolved launch token in the path', () => {
  // A gezel that "works around" a gate checking a literal `{{task.dir}}/…`
  // path by writing there produces a real directory named `{{task.dir}}` and
  // satisfies nothing (task gezel/7). Gezel-initiated writes only — a user
  // scaffolding a cookiecutter tree means those braces literally.
  it('refuses a gezel-initiated write to a literal {{token}} path', async () => {
    await expect(
      store.writeProjectWorkspaceFile(projectId, '{{task.dir}}/scope.md', 'x', {
        gezelId: 'g1',
      }),
    ).rejects.toThrow(/unresolved template placeholder/);
  });

  it('leaves a user-initiated write alone', async () => {
    await store.writeProjectWorkspaceFile(projectId, '{{cookiecutter.name}}/README.md', 'x');
    expect(await readBack('{{cookiecutter.name}}/README.md')).toBe('x');
  });

  it('still writes the resolved path for a gezel', async () => {
    await store.writeProjectWorkspaceFile(projectId, 'tasks/7/scope.md', 'real', {
      gezelId: 'g1',
    });
    expect(await readBack('tasks/7/scope.md')).toBe('real');
  });
});
