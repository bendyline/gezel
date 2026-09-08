import assert from 'node:assert/strict';
import test from 'node:test';
import { npmPackFiles, npmPackPayload } from './npm-pack-output.mjs';

const packageName = '@bendyline/gezel-service';
const options = { packageName, payloadLabel: 'service' };
const payload = {
  name: packageName,
  files: [{ path: 'dist\\index.js' }, { path: 'package.json' }],
};

test('reads the npm 12 package-keyed JSON shape', () => {
  assert.deepEqual(npmPackPayload(JSON.stringify({ [packageName]: payload }), options), payload);
  assert.deepEqual(npmPackFiles(JSON.stringify({ [packageName]: payload }), options), [
    'dist/index.js',
    'package.json',
  ]);
});

test('continues to read array and direct npm pack JSON shapes', () => {
  const expected = ['dist/index.js', 'package.json'];
  assert.deepEqual(npmPackFiles(JSON.stringify([payload]), options), expected);
  assert.deepEqual(npmPackFiles(JSON.stringify(payload), options), expected);
});

test('selects the requested package from multi-package output', () => {
  const other = { name: '@bendyline/other', files: [{ path: 'other.js' }] };
  assert.deepEqual(
    npmPackFiles(JSON.stringify({ [other.name]: other, [packageName]: payload }), options),
    ['dist/index.js', 'package.json'],
  );
});

test('rejects JSON without an unambiguous package payload', () => {
  assert.throws(
    () => npmPackFiles(JSON.stringify({ notice: 'nothing packed' }), options),
    /npm pack returned no service payload/,
  );
});
