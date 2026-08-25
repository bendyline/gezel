import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { checkLayerDirection, findForbiddenImports } from './check-layer-direction.mjs';

const FORBIDDEN = ['chat', 'http', 'providers'];

test('flags runtime imports from a forbidden layer', () => {
  const failures = findForbiddenImports(
    `import { helper } from '../chat/file-references.js';\n`,
    FORBIDDEN,
  );
  assert.equal(failures.length, 1);
  assert.equal(failures[0].specifier, '../chat/file-references.js');
  assert.equal(failures[0].line, 1);
});

test('flags multi-line named imports and mixed type/value clauses', () => {
  const source = [
    'import {',
    '  type FileInventoryIndex,',
    '  buildFileInventoryIndex,',
    "} from '../chat/file-references.js';",
    '',
  ].join('\n');
  assert.equal(findForbiddenImports(source, FORBIDDEN).length, 1);
});

test('allows type-only imports and unrelated specifiers', () => {
  const source = [
    "import type { ChatEventBus } from '../chat/events.js';",
    "import { safeJoin } from './safe-paths.js';",
    "import { createLogger } from '@bendyline/gezel/log';",
    "import { inspectGitWorkdir } from '../git/inspect.js';",
    '',
  ].join('\n');
  assert.equal(findForbiddenImports(source, FORBIDDEN).length, 0);
});

test('flags re-exports but not type-only re-exports', () => {
  assert.equal(
    findForbiddenImports(`export { thing } from '../http/routes.js';\n`, FORBIDDEN).length,
    1,
  );
  assert.equal(
    findForbiddenImports(`export type { Shape } from '../http/routes.js';\n`, FORBIDDEN).length,
    0,
  );
});

test('scans the rule directory, skips tests, and reports file:line', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'gezel-layer-direction-'));
  try {
    const fsDir = join(rootDir, 'packages/service/src/fs');
    await mkdir(fsDir, { recursive: true });
    await writeFile(
      join(fsDir, 'store.ts'),
      `import { x } from './atomic.js';\nimport { y } from '../chat/manager.js';\n`,
    );
    await writeFile(join(fsDir, 'store.test.ts'), `import { y } from '../chat/manager.js';\n`);
    const failures = await checkLayerDirection({ rootDir });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /^packages\/service\/src\/fs\/store\.ts:2: /);
    assert.match(failures[0], /'\.\.\/chat\/manager\.js'/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('the real tree passes', async () => {
  assert.deepEqual(await checkLayerDirection(), []);
});
