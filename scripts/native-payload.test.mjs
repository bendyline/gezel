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
const unixWrapperPaths = [
  '../native/engines/llama-cpp/build.sh',
  '../native/engines/sd-cpp/build.sh',
  '../native/engines/whisper-cpp/build.sh',
  '../native/engines/ds4/build.sh',
  '../native/helpers/device-health/build.sh',
].map((path) => [path, readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')]);
const windowsWrapperPaths = [
  '../native/engines/llama-cpp/build.ps1',
  '../native/engines/sd-cpp/build.ps1',
  '../native/engines/whisper-cpp/build.ps1',
  '../native/helpers/device-health/build.ps1',
  '../native/helpers/service-host/build.ps1',
].map((path) => [path, readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')]);

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

test('Windows native signing passes resolved file paths to signtool', () => {
  const start = workflow.indexOf('      - name: Sign Windows native payload (Authenticode)');
  const end = workflow.indexOf('      - name: Import Apple signing certificate (macOS)', start);
  assert.notEqual(start, -1, 'could not find the Windows native signing step');
  assert.notEqual(end, -1, 'could not find the end of the Windows native signing step');
  const step = workflow.slice(start, end);

  assert.match(step, /"\$\(\$target\.FullName\)"/);
  assert.doesNotMatch(
    step,
    /"\$target\.FullName"/,
    'PowerShell appends literal `.FullName` inside this interpolation form',
  );
});

test('macOS deployment compatibility is declared and checked before signing', () => {
  assert.match(workflow, /^\s{2}MACOSX_DEPLOYMENT_TARGET: '13\.3'$/m);
  const start = workflow.indexOf('      - name: Assert macOS deployment target');
  const end = workflow.indexOf('      # ── Code-sign the engine binaries', start);
  assert.notEqual(start, -1, 'could not find the macOS deployment-target gate');
  assert.notEqual(end, -1, 'could not find the signing boundary after the macOS gate');
  const step = workflow.slice(start, end);

  assert.match(step, /vtool -show-build/);
  assert.match(step, /version_gt "\$minos" "\$floor"/);
  assert.match(step, /No Mach-O files found/);
});

test('Unix native payloads fail closed on hosted-runner path leaks', () => {
  const start = workflow.indexOf('      - name: Assert no build-host paths');
  const end = workflow.indexOf('      # ── Code-sign the engine binaries', start);
  assert.notEqual(start, -1, 'could not find the build-host path gate');
  assert.notEqual(end, -1, 'could not find the signing boundary after the path gate');
  const step = workflow.slice(start, end);

  assert.match(step, /matrix\.engine != 'uv'/);
  assert.match(step, /!startsWith\(matrix\.platform, 'win32'\)/);
  assert.match(step, /\/home\/runner\/work\//);
  assert.match(step, /\/Users\/runner\/work\//);
  assert.doesNotMatch(step, /\[A-Za-z\]:\\\\a\\\\/);
});

test('Unix native wrappers configure stable source path remapping', () => {
  for (const [path, contents] of unixWrapperPaths) {
    assert.match(
      contents,
      /-ffile-prefix-map=/,
      `${path} does not configure source path remapping`,
    );
  }

  for (const path of [
    '../native/engines/llama-cpp/build.sh',
    '../native/engines/sd-cpp/build.sh',
    '../native/engines/whisper-cpp/build.sh',
  ]) {
    const contents = unixWrapperPaths.find(([candidate]) => candidate === path)?.[1] ?? '';
    assert.match(contents, /CMAKE_OSX_DEPLOYMENT_TARGET/);
  }

  for (const path of [
    '../native/engines/llama-cpp/build.sh',
    '../native/engines/sd-cpp/build.sh',
    '../native/engines/whisper-cpp/build.sh',
    '../native/engines/ds4/build.sh',
  ]) {
    const contents = unixWrapperPaths.find(([candidate]) => candidate === path)?.[1] ?? '';
    assert.match(
      contents,
      /MACOSX_DEPLOYMENT_TARGET:-13\.3/,
      `${path} does not default to the declared macOS 13.3 floor`,
    );
  }

  const llama = unixWrapperPaths.find(([path]) => path.includes('llama-cpp/build.sh'))?.[1] ?? '';
  const sd = unixWrapperPaths.find(([path]) => path.includes('sd-cpp/build.sh'))?.[1] ?? '';
  const ds4 = unixWrapperPaths.find(([path]) => path.includes('ds4/build.sh'))?.[1] ?? '';
  assert.match(llama, /CMAKE_CUDA_FLAGS=.*-Xcompiler=-ffile-prefix-map=/);
  assert.match(sd, /CMAKE_CUDA_FLAGS=.*-Xcompiler=-ffile-prefix-map=/);
  assert.match(ds4, /NVCCFLAGS=.*source_map|nvcc_flags\+=.*-ffile-prefix-map=/);
});

test('Windows native wrappers avoid experimental path remapping', () => {
  for (const [path, contents] of windowsWrapperPaths) {
    assert.doesNotMatch(contents, /\/pathmap:/, `${path} enables MSVC /pathmap`);
    assert.doesNotMatch(
      contents,
      /\/experimental:deterministic/,
      `${path} enables an experimental MSVC mode`,
    );
  }
});

test('native tar archives normalize ownership, ordering, and timestamps', () => {
  const intermediate = workflow.slice(
    workflow.indexOf('      - name: Pack build output'),
    workflow.indexOf(
      '      - uses: actions/upload-artifact',
      workflow.indexOf('      - name: Pack build output'),
    ),
  );
  assert.match(intermediate, /--uid 0 --gid 0 --uname root --gname root/);
  assert.match(intermediate, /--owner=0 --group=0 --numeric-owner/);

  const release = workflow.slice(
    workflow.indexOf('      - name: Pack tarballs'),
    workflow.indexOf('      - name: Validate archive sizes'),
  );
  assert.match(release, /source_date_epoch=.*git show/);
  assert.match(release, /--sort=name/);
  assert.match(release, /--mtime="@\$\{source_date_epoch\}"/);
  assert.match(release, /--owner=0 --group=0 --numeric-owner/);
});
