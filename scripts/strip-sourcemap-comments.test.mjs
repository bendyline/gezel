import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  stripSourcemapComments,
  stripSourcemapCommentsFromText,
} from './strip-sourcemap-comments.mjs';

test('strips line and block source-map comments without touching program text', () => {
  const source = [
    "console.log('sourceMappingURL=inside-a-string');",
    '//# sourceMappingURL=index.js.map',
    '/*# sourceMappingURL=inline.js.map */',
    '',
  ].join('\n');
  const result = stripSourcemapCommentsFromText(source);

  assert.equal(result.commentsRemoved, 2);
  assert.equal(result.text, "console.log('sourceMappingURL=inside-a-string');\n\n");
});

test('recursively strips JavaScript build outputs, preserves maps, and is idempotent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gezel-strip-sourcemaps-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(
    join(root, 'index.js'),
    'export const value = 1;\n//# sourceMappingURL=index.js.map\n',
  );
  await writeFile(
    join(root, 'assets', 'worker.mjs'),
    'self.x=1;\n//# sourceMappingURL=worker.mjs.map',
  );
  await writeFile(join(root, 'index.js.map'), '{"version":3}\n');
  await writeFile(join(root, 'notes.txt'), '//# sourceMappingURL=not-javascript.map\n');

  assert.deepEqual(await stripSourcemapComments([root]), {
    filesChanged: 2,
    commentsRemoved: 2,
  });
  assert.equal(await readFile(join(root, 'index.js'), 'utf8'), 'export const value = 1;\n');
  assert.equal(await readFile(join(root, 'assets', 'worker.mjs'), 'utf8'), 'self.x=1;\n');
  assert.equal(await readFile(join(root, 'index.js.map'), 'utf8'), '{"version":3}\n');
  assert.equal(
    await readFile(join(root, 'notes.txt'), 'utf8'),
    '//# sourceMappingURL=not-javascript.map\n',
  );
  assert.deepEqual(await stripSourcemapComments([root]), {
    filesChanged: 0,
    commentsRemoved: 0,
  });
});
