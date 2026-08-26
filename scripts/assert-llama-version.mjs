#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION_OUTPUT = /\bversion:\s*(\d+)\s+\(([0-9a-f]{7,40})\)/i;

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
  const match = output.match(VERSION_OUTPUT);
  if (!match) {
    throw new Error(
      `llama --version output has no "version: <number> (<commit>)" identity: ${output.trim()}`,
    );
  }
  return { buildNumber: Number.parseInt(match[1], 10), commit: match[2].toLowerCase() };
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
