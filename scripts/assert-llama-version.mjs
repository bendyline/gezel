#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// llama.cpp printed `version: <build> (<commit>)` through the b#### era and
// switched at v0.3.0 to `version: <semver> (build <n>, commit <sha>)`
// (common/build-info.cpp). Both are accepted: a bisect pin on an older
// b#### tag still has to be verifiable.
const VERSION_MODERN =
  /\bversion:\s*(\S+)\s+\(\s*build\s+(\d+)\s*,\s*commit\s+([0-9a-f]{7,40})\s*\)/i;
const VERSION_LEGACY = /\bversion:\s*(\d+)\s+\(([0-9a-f]{7,40})\)/i;

// Upstream publishes semver stable tags (`v0.3.0`) alongside the rolling
// `b####` prereleases, so the build number the binary reports is no longer
// readable off the tag. `build=` states it; a `b####` tag still derives it,
// and when both are present they must agree or the pin is internally
// inconsistent and every downstream identity check would compare against a
// number nothing produced.
export function parseLlamaPin(contents) {
  const tag = contents.match(/^tag=(\S+)\s*$/m)?.[1];
  const commit = contents.match(/^commit=([0-9a-f]{40})\s*$/m)?.[1];
  if (!tag || !commit) {
    throw new Error('llama VERSION must contain tag= and a 40-character commit');
  }

  const declared = contents.match(/^build=(\d+)\s*$/m)?.[1];
  const derived = tag.match(/^b(\d+)$/)?.[1];
  if (declared === undefined && derived === undefined) {
    throw new Error(
      `llama VERSION tag ${tag} is not a b<number> tag, so it must declare build=<number>`,
    );
  }
  if (declared !== undefined && derived !== undefined && declared !== derived) {
    throw new Error(`llama VERSION declares build=${declared} but tag ${tag} implies ${derived}`);
  }

  return { buildNumber: Number.parseInt(declared ?? derived, 10), commit, tag };
}

export function parseLlamaVersionOutput(output) {
  const modern = output.match(VERSION_MODERN);
  if (modern) {
    return {
      buildNumber: Number.parseInt(modern[2], 10),
      commit: modern[3].toLowerCase(),
      version: modern[1],
    };
  }
  const legacy = output.match(VERSION_LEGACY);
  if (legacy) {
    return { buildNumber: Number.parseInt(legacy[1], 10), commit: legacy[2].toLowerCase() };
  }
  throw new Error(`llama --version output has no recognizable identity: ${output.trim()}`);
}

export function assertLlamaVersionIdentity(output, expected) {
  const actual = parseLlamaVersionOutput(output);
  if (actual.buildNumber !== expected.buildNumber) {
    throw new Error(
      `llama executable reports build ${actual.buildNumber}, expected ${expected.buildNumber} from ${expected.tag}`,
    );
  }
  if (!expected.commit.startsWith(actual.commit)) {
    throw new Error(
      `llama executable reports commit ${actual.commit}, expected a short prefix of ${expected.commit}`,
    );
  }

  // A semver pin gives the binary's own version string something to be checked
  // against. `-dev` means the build did not pass -DLLAMA_BUILD_IS_DEV=OFF, so
  // it is stamped an upstream nightly — a release artifact must not be.
  const pinnedVersion = expected.tag.match(/^v(\d+\.\d+\.\d+)$/)?.[1];
  if (pinnedVersion && actual.version && actual.version !== pinnedVersion) {
    const hint = actual.version.startsWith(`${pinnedVersion}-`)
      ? ' — build it with -DLLAMA_BUILD_IS_DEV=OFF'
      : '';
    throw new Error(
      `llama executable reports version ${actual.version}, expected ${pinnedVersion} from ${expected.tag}${hint}`,
    );
  }

  return actual;
}

function parseArgs(argv) {
  const args = { binary: '', versionFile: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--binary') args.binary = argv[++index] ?? '';
    else if (argument === '--version-file') args.versionFile = argv[++index] ?? '';
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!args.binary || !args.versionFile) {
    throw new Error('usage: assert-llama-version.mjs --binary <path> --version-file <path>');
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const binary = resolve(args.binary);
  const expected = parseLlamaPin(readFileSync(resolve(args.versionFile), 'utf8'));
  const result = spawnSync(binary, ['--version'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 60_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0) {
    throw new Error(
      `${binary} --version exited with status ${result.status}${output.trim() ? `: ${output.trim()}` : ''}`,
    );
  }

  const actual = assertLlamaVersionIdentity(output, expected);
  if (output.trim()) process.stdout.write(`${output.trim()}\n`);
  process.stdout.write(
    `[llama-version] verified build ${actual.buildNumber}, commit ${actual.commit}\n`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(`[llama-version] ${error.message}`);
    process.exitCode = 1;
  }
}
