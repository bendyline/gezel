#!/usr/bin/env node
/** Check the finished installer: fpm's emitted metadata is the install gate. */
import { execFileSync } from 'node:child_process';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// build-native.yml caps ELF requirements at these symbol versions. The contract
// test couples that cap to the package requirements and electron-builder config.
export const LINUX_SYMBOL_FLOOR = { glibc: '2.38', glibcxx: '3.4.32', cxxabi: '1.3.15' };
export const LINUX_RUNTIME_DEPENDENCIES = {
  deb: [`libc6 (>= ${LINUX_SYMBOL_FLOOR.glibc})`, 'libstdc++6 (>= 14.1.0)'],
  rpm: [
    `libc.so.6(GLIBC_${LINUX_SYMBOL_FLOOR.glibc})(64bit)`,
    `libstdc++.so.6(GLIBCXX_${LINUX_SYMBOL_FLOOR.glibcxx})(64bit)`,
    `libstdc++.so.6(CXXABI_${LINUX_SYMBOL_FLOOR.cxxabi})(64bit)`,
  ],
};
const architectures = { deb: ['amd64', 'arm64'], rpm: ['x86_64', 'aarch64'] };

export function assertLinuxRuntimeDependencies(format, requirements, architecture) {
  if (!architectures[format]?.includes(architecture)) {
    throw new Error(`unsupported ${format} architecture: ${architecture}`);
  }
  // Each required dependency must stand alone. An alternative such as
  // "libc6 (>= 2.38) | libc6" lets unsupported machines through.
  const normalize = (value) => value.replace(/\s+/g, '');
  const dependencies = requirements.split(format === 'deb' ? ',' : '\n').map(normalize);
  for (const dependency of LINUX_RUNTIME_DEPENDENCIES[format]) {
    if (!dependencies.includes(normalize(dependency))) {
      throw new Error(`${format}/${architecture} is missing mandatory dependency: ${dependency}`);
    }
  }
}

export function verifyLinuxRuntimeDependencies(artifact, run = execFileSync) {
  const format = extname(artifact).slice(1).toLowerCase();
  if (!Object.hasOwn(LINUX_RUNTIME_DEPENDENCIES, format)) {
    throw new Error('expected a .deb or .rpm installer');
  }
  const path = resolve(artifact);
  const query = (command, args) =>
    run(command, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 }).trim();
  const architecture =
    format === 'deb'
      ? query('dpkg-deb', ['--field', path, 'Architecture'])
      : query('rpm', ['-qp', '--queryformat', '%{ARCH}', path]);
  const requirements =
    format === 'deb'
      ? query('dpkg-deb', ['--field', path, 'Depends'])
      : query('rpm', ['-qpR', path]);
  assertLinuxRuntimeDependencies(format, requirements, architecture);
  return { format, architecture, requirements: LINUX_RUNTIME_DEPENDENCIES[format] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) {
      throw new Error('usage: verify-linux-runtime-dependencies.mjs <installer.deb|installer.rpm>');
    }
    const result = verifyLinuxRuntimeDependencies(process.argv[2]);
    console.log(
      `Linux runtime dependencies verified (${result.format}/${result.architecture}): ${result.requirements.join(', ')}`,
    );
  } catch (error) {
    console.error(`Linux runtime dependency verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
