#!/usr/bin/env node
/** Prove a Linux Vulkan consumer resolves its loader inside its own archive. */
import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export function verifyVulkanPayload(output, consumer) {
  const bundle = realpathSync(output);
  const loader = join(bundle, 'libvulkan.so.1');
  // A concrete file avoids SDK symlinks escaping or losing their targets
  // during artifact packaging. The build uses cp -L to produce this path.
  if (!lstatSync(loader).isFile()) {
    throw new Error('libvulkan.so.1 must be a regular file inside the bundle');
  }
  const target = realpathSync(consumer);
  const relativeTarget = relative(bundle, target);
  if (!relativeTarget || isAbsolute(relativeTarget) || relativeTarget.split(sep)[0] === '..') {
    throw new Error(`Vulkan consumer is outside the bundle: ${target}`);
  }

  // CI exports the SDK library directory for compilation. Letting that
  // override RUNPATH would test the SDK rather than the packaged loader.
  const env = { ...process.env };
  delete env.LD_LIBRARY_PATH;
  delete env.LD_PRELOAD;
  const result = spawnSync('ldd', [target], {
    encoding: 'utf8',
    env,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`ldd failed for ${target}: ${result.stderr || result.stdout}`);
  }
  if (/=>\s+not found\s*$/m.test(result.stdout)) {
    throw new Error(`Vulkan consumer has unresolved dependencies:\n${result.stdout}`);
  }
  const match = result.stdout.match(/^\s*libvulkan\.so\.1\s+=>\s+(.+?)\s+\(0x[0-9a-f]+\)\s*$/im);
  if (!match) throw new Error('ldd did not resolve libvulkan.so.1 for the Vulkan consumer');
  const resolved = realpathSync(match[1]);
  if (resolved !== loader) {
    throw new Error(`libvulkan.so.1 resolves outside the bundle: ${resolved}`);
  }
  return resolved;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [output, consumer, ...extra] = process.argv.slice(2);
    if (!output || !consumer || extra.length) {
      throw new Error('usage: verify-vulkan-payload.mjs <output-directory> <Vulkan-consumer>');
    }
    const loader = verifyVulkanPayload(output, consumer);
    console.log(`[vulkan-payload] verified bundled loader: ${loader}`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
