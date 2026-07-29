import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stageSharpCompatibilityStub, verifySharpCompatibilityTree } from './sharp-compat.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const requireFromService = createRequire(join(root, 'packages', 'service', 'package.json'));

function assertStubFrom(entry) {
  const requireFromDependency = createRequire(entry);
  const pkg = requireFromDependency('sharp/package.json');
  const sharp = requireFromDependency('sharp');
  assert.equal(pkg.gezelSharpCompatibilityStub, true);
  assert.equal(sharp.gezelSharpCompatibilityStub, true);
  assert.throws(
    () => sharp(Buffer.alloc(0)),
    (error) => error?.code === 'GEZEL_TRANSFORMERS_IMAGE_UNSUPPORTED',
  );
}

async function importEsmTwin(cjsEntry, esmName) {
  return import(pathToFileURL(join(dirname(cjsEntry), esmName)).href);
}

test('both Transformers.js dependency trees load against the no-image stub', async () => {
  const directEntry = requireFromService.resolve('@huggingface/transformers');
  assertStubFrom(directEntry);
  const direct = await importEsmTwin(directEntry, 'transformers.node.mjs');
  assert.equal(typeof direct.pipeline, 'function');

  const image = new direct.RawImage(new Uint8ClampedArray([0, 0, 0]), 1, 1, 3);
  assert.throws(
    () => image.toSharp(),
    (error) => error?.code === 'GEZEL_TRANSFORMERS_IMAGE_UNSUPPORTED',
  );

  const kokoroEntry = requireFromService.resolve('kokoro-js');
  const requireFromKokoro = createRequire(kokoroEntry);
  const nestedEntry = requireFromKokoro.resolve('@huggingface/transformers');
  assert.notEqual(
    nestedEntry,
    directEntry,
    'the test must exercise Kokoro’s distinct Transformers.js major version',
  );
  assertStubFrom(nestedEntry);
  const nested = await importEsmTwin(nestedEntry, 'transformers.node.mjs');
  assert.equal(typeof nested.pipeline, 'function');

  const kokoro = await importEsmTwin(kokoroEntry, 'kokoro.js');
  assert.equal(typeof kokoro.KokoroTTS, 'function');
});

test('deployment staging materializes the marked stub', async (t) => {
  const tree = await mkdtemp(join(tmpdir(), 'gezel-sharp-compat-'));
  t.after(() => rm(tree, { recursive: true, force: true }));

  await stageSharpCompatibilityStub(tree);
  assert.deepEqual(await verifySharpCompatibilityTree(tree), { stubs: 1 });
  const sharpRoot = join(tree, 'node_modules', 'sharp');
  const requireFromTree = createRequire(join(tree, 'package.json'));
  const sharp = requireFromTree('sharp');
  assert.equal(sharp.gezelSharpCompatibilityStub, true);
  assert.throws(
    () => sharp(Buffer.alloc(0)),
    (error) => error?.code === 'GEZEL_TRANSFORMERS_IMAGE_UNSUPPORTED',
  );
  assert.equal(
    JSON.parse(await readFile(join(sharpRoot, 'package.json'), 'utf8')).gezelSharpCompatibilityStub,
    true,
  );
});

test('deployment staging refuses to replace upstream Sharp', async (t) => {
  const tree = await mkdtemp(join(tmpdir(), 'gezel-sharp-existing-'));
  t.after(() => rm(tree, { recursive: true, force: true }));
  const sharpRoot = join(tree, 'node_modules', 'sharp');
  await mkdir(sharpRoot, { recursive: true });
  await writeFile(join(sharpRoot, 'package.json'), JSON.stringify({ name: 'sharp' }));

  await assert.rejects(stageSharpCompatibilityStub(tree), /refusing to replace upstream Sharp/);
});

test('deployment verification rejects upstream Sharp', async (t) => {
  const tree = await mkdtemp(join(tmpdir(), 'gezel-sharp-native-'));
  t.after(() => rm(tree, { recursive: true, force: true }));
  const sharpRoot = join(tree, 'node_modules', 'sharp');
  await mkdir(sharpRoot, { recursive: true });
  await writeFile(join(sharpRoot, 'package.json'), JSON.stringify({ name: 'sharp' }));

  await assert.rejects(
    verifySharpCompatibilityTree(tree),
    /upstream Sharp package survived deployment/,
  );
});

test('deployment verification rejects a libvips payload beside the stub', async (t) => {
  const tree = await mkdtemp(join(tmpdir(), 'gezel-libvips-native-'));
  t.after(() => rm(tree, { recursive: true, force: true }));
  const sharpRoot = join(tree, 'node_modules', 'sharp');
  await mkdir(sharpRoot, { recursive: true });
  await writeFile(
    join(sharpRoot, 'package.json'),
    JSON.stringify({ name: 'sharp', gezelSharpCompatibilityStub: true }),
  );
  await writeFile(join(sharpRoot, 'libvips-cpp.dylib'), '');

  await assert.rejects(
    verifySharpCompatibilityTree(tree),
    /native Sharp\/libvips payload survived deployment/,
  );
});
