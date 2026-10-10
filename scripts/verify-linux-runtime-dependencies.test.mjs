import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  LINUX_RUNTIME_DEPENDENCIES,
  LINUX_SYMBOL_FLOOR,
  assertLinuxRuntimeDependencies,
  verifyLinuxRuntimeDependencies,
} from './verify-linux-runtime-dependencies.mjs';

const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { parse } = require('yaml');
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('both Linux package formats enforce the native build symbol floor', () => {
  const builder = parse(source('packages/app/electron-builder.yml'));
  const native = parse(source('.github/workflows/build-native.yml'));
  assert.equal(native.env.LINUX_MAX_GLIBC, LINUX_SYMBOL_FLOOR.glibc);
  assert.equal(native.env.LINUX_MAX_GLIBCXX, LINUX_SYMBOL_FLOOR.glibcxx);
  assert.equal(native.env.LINUX_MAX_CXXABI, LINUX_SYMBOL_FLOOR.cxxabi);
  const nativeGuard = Object.values(native.jobs)
    .flatMap((job) => job.steps ?? [])
    .find((step) => step.name === 'Assert Linux symbol-version floor').run;
  assert.match(nativeGuard, /c=\$\(highest "\$f" 'CXXABI_'\)/);
  assert.match(nativeGuard, /gt "\$c" "\$\{LINUX_MAX_CXXABI\}"/);
  for (const [format, arches] of [
    ['deb', ['amd64', 'arm64']],
    ['rpm', ['x86_64', 'aarch64']],
  ]) {
    for (const arch of arches) {
      assertLinuxRuntimeDependencies(
        format,
        builder[format].depends.join(format === 'deb' ? ',' : '\n'),
        arch,
      );
    }
  }
});

test('DEB metadata rejects missing, weak, optional and wrong-architecture constraints', () => {
  const current = LINUX_RUNTIME_DEPENDENCIES.deb.join(', ');
  for (const bad of [
    'acl, systemd',
    current.replace('2.38', '2.35'),
    current.replace('14.1.0', '13.2.0'),
    current.replace('libc6 (>= 2.38)', 'libc6 (>= 2.38) | libc6'),
    current.replace('libstdc++6 (>= 14.1.0)', 'libstdc++6'),
  ]) {
    assert.throws(() => assertLinuxRuntimeDependencies('deb', bad, 'arm64'), /missing mandatory/);
  }
  assert.throws(() => assertLinuxRuntimeDependencies('deb', current, 'i386'), /architecture/);
  assert.doesNotThrow(() => assertLinuxRuntimeDependencies('deb', `acl,\n ${current}`, 'amd64'));
});

test('RPM metadata needs all three exact 64-bit symbol capabilities', () => {
  const current = LINUX_RUNTIME_DEPENDENCIES.rpm.join('\n');
  for (const bad of [
    'glibc\nlibstdc++\ngtk3',
    current.replace('2.38', '2.37'),
    current.replace('3.4.32', '3.4.31'),
    current.replace('1.3.15', '1.3.14'),
    current
      .split('\n')
      .filter((line) => !line.includes('CXXABI'))
      .join('\n'),
    current.replaceAll('(64bit)', ''),
    `${LINUX_RUNTIME_DEPENDENCIES.rpm[0]}\n(${LINUX_RUNTIME_DEPENDENCIES.rpm[1]} or libstdc++)`,
  ]) {
    assert.throws(() => assertLinuxRuntimeDependencies('rpm', bad, 'aarch64'), /missing mandatory/);
  }
  assert.doesNotThrow(() =>
    assertLinuxRuntimeDependencies('rpm', `${current}\n/bin/sh\ngtk3`, 'x86_64'),
  );
});

test('artifact verification queries mandatory fields and propagates package-query failures', () => {
  for (const [format, arch, command] of [
    ['deb', 'amd64', 'dpkg-deb'],
    ['rpm', 'aarch64', 'rpm'],
  ]) {
    const calls = [];
    const result = verifyLinuxRuntimeDependencies(`/tmp/candidate.${format}`, (cmd, args) => {
      assert.equal(cmd, command);
      calls.push(args);
      return calls.length === 1
        ? arch
        : LINUX_RUNTIME_DEPENDENCIES[format].join(format === 'deb' ? ', ' : '\n');
    });
    assert.equal(result.architecture, arch);
    assert.deepEqual(
      calls[1],
      format === 'deb'
        ? ['--field', resolve('/tmp/candidate.deb'), 'Depends']
        : ['-qpR', resolve('/tmp/candidate.rpm')],
    );
  }
  assert.throws(
    () => verifyLinuxRuntimeDependencies('/tmp/candidate.zip'),
    /expected a .deb or .rpm/,
  );
  assert.throws(
    () =>
      verifyLinuxRuntimeDependencies('/tmp/broken.deb', () => {
        throw new Error('invalid archive');
      }),
    /invalid archive/,
  );
});

test('release CI checks both final installer formats before installation or upload', () => {
  const workflow = source('.github/workflows/release-electron.yml');
  const start = workflow.indexOf('- name: Verify Linux runtime dependencies');
  const end = workflow.indexOf('- name: Smoke-test packaged Linux app');
  assert.ok(start > 0 && end > start);
  const step = workflow.slice(start, end);
  assert.match(
    step,
    /for installer in packages\/app\/dist\/installers\/\*\.deb packages\/app\/dist\/installers\/\*\.rpm/,
  );
  assert.match(step, /node scripts\/verify-linux-runtime-dependencies\.mjs "\$installer"/);
  assert.match(workflow, /glibc 2\.38/);
  assert.match(workflow, /GLIBCXX_3\.4\.32/);
  assert.match(workflow, /CXXABI_1\.3\.15/);
});
