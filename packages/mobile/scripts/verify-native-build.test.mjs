import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { verifyNativeBuild } from './verify-native-build.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
async function fixture(run) {
  const repo = await mkdtemp(path.join(tmpdir(), 'gezel-native-manifest-'));
  const build = path.join(repo, 'output');
  try {
    await mkdir(path.join(repo, 'native/engines/llama-cpp'), { recursive: true });
    await mkdir(path.join(repo, 'native/mobile'), { recursive: true });
    await mkdir(path.join(build, 'jniLibs/arm64-v8a'), { recursive: true });
    const upstream = {
      upstream: 'https://example.invalid/engine',
      tag: 'test',
      build: '1',
      commit: 'a'.repeat(40),
    };
    await writeFile(
      path.join(repo, 'native/engines/llama-cpp/VERSION'),
      Object.entries(upstream)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
    );
    const bridgeSources = {};
    for (const name of ['gezel_llama.h', 'gezel_llama.cpp', 'utf8_stream.h', 'CMakeLists.txt']) {
      await writeFile(path.join(repo, 'native/mobile', name), name);
      bridgeSources[name] = hash(name);
    }
    const payload = 'jniLibs/arm64-v8a/libgezel-llama.so';
    await writeFile(path.join(build, payload), 'verified fixture bytes');
    const manifest = {
      schemaVersion: 1,
      target: 'android',
      gezelABIVersion: 1,
      upstream,
      bridgeSources,
      files: { [payload]: hash('verified fixture bytes') },
    };
    await writeFile(path.join(build, 'manifest.json'), JSON.stringify(manifest));
    await run({ repo, build, payload, manifest });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

test('accepts the current pinned source and exact payload', () =>
  fixture(async ({ repo, build }) => {
    assert.equal((await verifyNativeBuild(repo, build, 'android')).target, 'android');
  }));

for (const mutation of ['payload', 'bridge', 'pin', 'extra', 'escape']) {
  test(`rejects native ${mutation} drift before sync`, () =>
    fixture(async ({ repo, build, payload, manifest }) => {
      if (mutation === 'payload') await writeFile(path.join(build, payload), 'changed');
      if (mutation === 'bridge')
        await writeFile(path.join(repo, 'native/mobile/gezel_llama.cpp'), 'changed');
      if (mutation === 'pin') {
        const file = path.join(repo, 'native/engines/llama-cpp/VERSION');
        await writeFile(file, (await readFile(file, 'utf8')).replace('build=1', 'build=2'));
      }
      if (mutation === 'extra')
        await writeFile(path.join(build, 'jniLibs/arm64-v8a/extra.so'), 'extra');
      if (mutation === 'escape') {
        manifest.files['../outside'] = hash('outside');
        await writeFile(path.join(build, 'manifest.json'), JSON.stringify(manifest));
      }
      await assert.rejects(
        () => verifyNativeBuild(repo, build, 'android'),
        /mismatch|differs|old build|Unverified|Invalid native manifest path/,
      );
    }));
}
