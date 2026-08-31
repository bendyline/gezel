/**
 * The vendored-engine resolve path — DuckDB.
 *
 * Hermetic: a fake zip is served from a `file://`-free stub fetch, and the
 * signature check is overridden, so nothing here touches the network or
 * `codesign`. The live behaviour (real download, real Developer ID check
 * against the DuckDB Foundation's team) is exercised by hand when the pin
 * moves; what must never regress silently is the *rejection* behaviour, which
 * is what these cases pin down.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { duckdbInstallDir } from '@bendyline/gezel/native';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EngineUnavailableError, type ResolveEngineOptions, resolveEngine } from './resolver.js';

let home: string;
const priorBin = process.env.GEZEL_DUCKDB_BIN;
const priorNativeDir = process.env.GEZEL_NATIVE_BIN_DIR;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-duckdb-resolve-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  if (priorBin === undefined) delete process.env.GEZEL_DUCKDB_BIN;
  else process.env.GEZEL_DUCKDB_BIN = priorBin;
  if (priorNativeDir === undefined) delete process.env.GEZEL_NATIVE_BIN_DIR;
  else process.env.GEZEL_NATIVE_BIN_DIR = priorNativeDir;
});

const binaryName = process.platform === 'win32' ? 'duckdb.exe' : 'duckdb';

function sha(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** A zip holding one fake `duckdb` executable, plus both digests for it. */
function fakeArchive(contents = '#!/bin/sh\necho fake\n') {
  const zip = new AdmZip();
  const binary = Buffer.from(contents);
  zip.addFile(binaryName, binary);
  const archive = zip.toBuffer();
  return { archive, archiveSha: sha(archive), binarySha: sha(binary) };
}

function stubFetch(archive: Buffer): typeof fetch {
  return (async () =>
    new Response(new Uint8Array(archive), {
      status: 200,
      headers: { 'content-length': String(archive.byteLength) },
    })) as unknown as typeof fetch;
}

async function drain(opts: ResolveEngineOptions) {
  const gen = resolveEngine(opts);
  const events: string[] = [];
  let step = await gen.next();
  while (!step.done) {
    events.push((step.value as { type: string }).type);
    step = await gen.next();
  }
  return { result: step.value, events };
}

function baseOpts(archive: ReturnType<typeof fakeArchive>): ResolveEngineOptions {
  return {
    engine: 'duckdb',
    home,
    fetchImpl: stubFetch(archive.archive),
    vendoredUrlOverride: 'https://example.invalid/duckdb.zip',
    expectedArchiveSha256: { 'duckdb_cli-osx-arm64.zip': archive.archiveSha },
    expectedBinarySha256: archive.binarySha,
    verifyOverride: async () => ({
      result: { status: 'valid' as const },
      accepted: true,
    }),
  } as unknown as ResolveEngineOptions;
}

describe('resolveEngine — vendored DuckDB', () => {
  it('lands the binary in the version-keyed directory shared with the bundle installer', async () => {
    const archive = fakeArchive();
    const { result } = await drain(baseOpts(archive));

    // The exact directory matters: the Electron bundle installer writes here
    // too, so one machine ends up with one verified copy regardless of which
    // install path produced it.
    expect(result.binPath).toBe(join(duckdbInstallDir(home), binaryName));
    expect(existsSync(result.binPath)).toBe(true);
    expect(await readFile(result.binPath, 'utf8')).toContain('fake');
    expect(result.cached).toBe(false);
    expect(process.env.GEZEL_DUCKDB_BIN).toBe(result.binPath);
  });

  it('does not repoint GEZEL_NATIVE_BIN_DIR at its own tree', async () => {
    // That variable is the root every other engine resolves siblings from.
    // DuckDB has no siblings in its version-keyed directory, so pointing it
    // there would break llama/sd/whisper discovery on the next boot.
    process.env.GEZEL_NATIVE_BIN_DIR = '/opt/native-bin';
    await drain(baseOpts(fakeArchive()));
    expect(process.env.GEZEL_NATIVE_BIN_DIR).toBe('/opt/native-bin');
  });

  it('records both digests in the sentinel and serves the second call from cache', async () => {
    const archive = fakeArchive();
    await drain(baseOpts(archive));

    const sentinel = JSON.parse(
      await readFile(join(duckdbInstallDir(home), '.verified.json'), 'utf8'),
    );
    expect(sentinel).toMatchObject({
      engine: 'duckdb',
      archiveSha: archive.archiveSha,
      binarySha: archive.binarySha,
    });

    const second = await drain(baseOpts(archive));
    expect(second.result.cached).toBe(true);
  });

  it('refuses an archive whose digest does not match the pin', async () => {
    const archive = fakeArchive();
    const opts = {
      ...baseOpts(archive),
      expectedArchiveSha256: { 'duckdb_cli-osx-arm64.zip': 'f'.repeat(64) },
    } as ResolveEngineOptions;
    await expect(drain(opts)).rejects.toBeInstanceOf(EngineUnavailableError);
    expect(existsSync(join(duckdbInstallDir(home), binaryName))).toBe(false);
  });

  it('refuses when the executable inside a correctly-hashed archive is not the pinned one', async () => {
    // The archive digest alone cannot catch this — it is exactly the case the
    // second digest exists for, and the case that would let the download path
    // and the bundle path disagree about what "the pinned build" means.
    const archive = fakeArchive();
    const opts = {
      ...baseOpts(archive),
      expectedBinarySha256: 'a'.repeat(64),
    } as ResolveEngineOptions;
    await expect(drain(opts)).rejects.toBeInstanceOf(EngineUnavailableError);
    expect(existsSync(join(duckdbInstallDir(home), binaryName))).toBe(false);
  });

  it('refuses a binary that fails the vendor signature check', async () => {
    const archive = fakeArchive();
    const opts = {
      ...baseOpts(archive),
      verifyOverride: async () => ({
        result: { status: 'untrusted' as const, detail: 'wrong team' },
        accepted: false,
      }),
    } as unknown as ResolveEngineOptions;
    await expect(drain(opts)).rejects.toBeInstanceOf(EngineUnavailableError);
    expect(existsSync(join(duckdbInstallDir(home), binaryName))).toBe(false);
  });

  it('re-downloads when the sentinel was written against a different pin', async () => {
    const first = fakeArchive('#!/bin/sh\necho one\n');
    await drain(baseOpts(first));

    const second = fakeArchive('#!/bin/sh\necho two\n');
    const { result } = await drain(baseOpts(second));
    expect(result.cached).toBe(false);
    expect(await readFile(result.binPath, 'utf8')).toContain('two');
  });
});
