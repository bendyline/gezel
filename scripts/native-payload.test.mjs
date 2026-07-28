/**
 * The one guarantee that keeps `scripts/native-payload.mjs` honest: it must
 * describe exactly what `.github/workflows/build-native.yml`'s matrix builds.
 *
 * Without this, adding an engine leg to the matrix and forgetting the table
 * fails open — the tagged native build packs an archive that quietly lacks
 * the new binary, every downstream gate passes because it only checks the
 * archive *set*, and the first symptom is a user whose engine won't start.
 * Adding a table entry with no matrix leg fails the other way: the tagged
 * build dies at pack time with no obvious cause.
 *
 * Parsed with a line scanner rather than a YAML library — no workspace
 * package depends on one, and pulling in a parser to lint a file we author
 * ourselves isn't worth the supply-chain surface. The scanner asserts it
 * found a plausible matrix so a reformat can't silently no-op the check.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { NATIVE_PAYLOAD, allPlatformKeys, expectedBinaries } from './native-payload.mjs';

const workflowPath = fileURLToPath(
  new URL('../.github/workflows/build-native.yml', import.meta.url),
);
const workflow = readFileSync(workflowPath, 'utf8');

/** Every `{platform, variant, artifact}` entry in the build matrix. */
function parseMatrix() {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => /^ {8}include:$/.test(line));
  assert.notEqual(start, -1, 'could not find the matrix `include:` block');

  const entries = [];
  let current = null;
  for (const line of lines.slice(start + 1)) {
    // The matrix ends where the job body resumes at four-space indent.
    if (/^ {4}\S/.test(line)) break;
    const entryStart = line.match(/^ {10}- (\w+): (.*)$/);
    if (entryStart) {
      current = {};
      entries.push(current);
      current[entryStart[1]] = unquote(entryStart[2]);
      continue;
    }
    const field = line.match(/^ {12}(\w+): (.*)$/);
    if (field && current) current[field[1]] = unquote(field[2]);
  }
  return entries;
}

function unquote(value) {
  return value
    .trim()
    .replace(/^'(.*)'$/, '$1')
    .replace(/^"(.*)"$/, '$1');
}

/** Matrix entries collapsed into the same shape as NATIVE_PAYLOAD. */
function payloadFromMatrix() {
  const byKey = new Map();
  for (const entry of parseMatrix()) {
    assert.ok(entry.platform, `matrix entry for ${entry.engine} has no platform`);
    assert.ok(entry.artifact, `matrix entry for ${entry.engine} has no artifact`);
    const key = entry.variant ? `${entry.platform}-${entry.variant}` : entry.platform;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(entry.artifact);
  }
  return byKey;
}

test('the build matrix parses into a plausible set of legs', () => {
  const entries = parseMatrix();
  assert.ok(
    entries.length >= 20,
    `parsed only ${entries.length} matrix entries — the scanner has drifted from the workflow's shape`,
  );
  for (const entry of entries) {
    assert.ok(entry.engine, 'every matrix entry names an engine');
    assert.ok(entry.runner, `matrix entry for ${entry.engine} has no runner`);
  }
});

test('native-payload.mjs covers exactly the platform keys the matrix builds', () => {
  const fromMatrix = [...payloadFromMatrix().keys()].sort();
  assert.deepEqual(allPlatformKeys().sort(), fromMatrix);
});

test('each platform key lists exactly the binaries its matrix legs emit', () => {
  for (const [key, artifacts] of payloadFromMatrix()) {
    assert.deepEqual(
      expectedBinaries(key)?.slice().sort(),
      artifacts.slice().sort(),
      `payload for ${key} disagrees with the build matrix`,
    );
  }
});

test('no platform key is declared with an empty binary list', () => {
  for (const key of allPlatformKeys()) {
    assert.ok(NATIVE_PAYLOAD[key].length > 0, `${key} declares no binaries`);
  }
});

test('standalone notarization trusts Accepted notarytool results without app assessment', () => {
  const start = workflow.indexOf('      - name: Notarize macOS native payload');
  const end = workflow.indexOf('      - name: Tear down keychain (macOS)', start);
  assert.notEqual(start, -1, 'could not find the standalone notarization step');
  assert.notEqual(end, -1, 'could not find the end of the standalone notarization step');
  const step = workflow.slice(start, end);

  assert.match(step, /xcrun notarytool submit/);
  assert.match(step, /\[\[ "\$status" != "Accepted" \|\| -z "\$submission_id" \]\]/);
  assert.doesNotMatch(
    step,
    /^\s*spctl\s/m,
    'bare command-line payloads must not be assessed as app bundles',
  );
});
