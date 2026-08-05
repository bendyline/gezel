/**
 * Contract for the gate that catches a stale pinned service host.
 *
 * The failure this guards against shipped once: v1.26217.38 added
 * `GEZEL_SERVICE_ROLE=machine-engine` to `env_overrides()` but was built
 * against a native release cut before that line existed, so the Windows
 * machine service launched its daemon with no role and silently ran the full
 * product API instead of the inference-only broker.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { binaryContainsWide, requiredLiteralsFromSource } from './verify-service-host-contract.mjs';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'verify-service-host-contract.mjs');
const MAIN_CPP = join(here, '..', 'native', 'helpers', 'service-host', 'src', 'main.cpp');

/** A stand-in for `.rdata`: the wide literals a compiler would emit. */
function fakeBinary(literals) {
  return Buffer.concat([
    Buffer.from('MZ\x90\x00'),
    ...literals.map((literal) => Buffer.from(`${literal}\0`, 'utf16le')),
  ]);
}

test('the required set is derived from the real env_overrides()', async () => {
  const { keys, values } = requiredLiteralsFromSource(await readFile(MAIN_CPP, 'utf8'));

  // The specific literal whose absence produced the incident.
  assert.ok(keys.includes('GEZEL_SERVICE_ROLE'), 'GEZEL_SERVICE_ROLE must be required');
  assert.ok(values.includes('machine-engine'), 'the role value must be required');

  // The rest of the launch contract the daemon depends on.
  for (const key of ['GEZEL_HOME', 'GEZEL_SYSTEM_SCOPE', 'ELECTRON_RUN_AS_NODE']) {
    assert.ok(keys.includes(key), `${key} must be required`);
  }
  // Path-shaped values are composed at runtime and cannot be pinned.
  assert.ok(
    !values.some((value) => value.includes('\\')),
    'runtime-composed paths must not be required as literals',
  );
});

test('parsing fails loudly rather than requiring nothing', () => {
  assert.throws(() => requiredLiteralsFromSource('int main() { return 0; }'), /env_overrides/);
  assert.throws(
    () =>
      requiredLiteralsFromSource('std::vector<EnvEntry> env_overrides(int a) {\n  return {};\n}'),
    /no literal keys/,
  );
});

test('wide-literal detection matches UTF-16LE, not UTF-8', () => {
  const binary = fakeBinary(['GEZEL_SERVICE_ROLE', 'machine-engine']);
  assert.ok(binaryContainsWide(binary, 'GEZEL_SERVICE_ROLE'));
  assert.ok(binaryContainsWide(binary, 'machine-engine'));
  assert.ok(!binaryContainsWide(binary, 'GEZEL_NOT_PRESENT'));
  assert.ok(
    !binary.includes(Buffer.from('GEZEL_SERVICE_ROLE', 'utf8')),
    'a UTF-8 scan would miss these literals entirely',
  );
});

test('a complete binary passes and a stale one fails with the missing key named', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gezel-host-contract-'));
  try {
    const { keys, values } = requiredLiteralsFromSource(await readFile(MAIN_CPP, 'utf8'));

    const good = join(dir, 'good.exe');
    await writeFile(good, fakeBinary([...keys, ...values]));
    const ok = await execFileAsync(process.execPath, [SCRIPT, good]);
    assert.match(ok.stdout, /launch contract intact/);

    // Exactly the shape of the shipped binary: everything except the role.
    const stale = join(dir, 'stale.exe');
    await writeFile(
      stale,
      fakeBinary(
        [...keys, ...values].filter(
          (literal) => literal !== 'GEZEL_SERVICE_ROLE' && literal !== 'machine-engine',
        ),
      ),
    );
    await assert.rejects(execFileAsync(process.execPath, [SCRIPT, stale]), (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /predates this checkout/);
      assert.match(err.stderr, /GEZEL_SERVICE_ROLE/);
      assert.match(err.stderr, /machine-engine/);
      assert.match(err.stderr, /pin-native-release/);
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
