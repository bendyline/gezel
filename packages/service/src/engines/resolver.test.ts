import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePlatformKey } from '@bendyline/gezel/native';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  EngineUnavailableError,
  impliedEngineVariant,
  resolveEngineToCompletion,
} from './resolver.js';

const PLATFORM_KEY = resolvePlatformKey() as string;
const IS_WIN = process.platform === 'win32';
const EXT = IS_WIN ? 'zip' : 'tar.gz';
const BIN = IS_WIN ? 'llama-server.exe' : 'llama-server';
const VERSION = '9.9.9';
const VARIANT = 'cpu';
const ARCHIVE_NAME = `gezel-native-${VERSION}-${PLATFORM_KEY}-${VARIANT}.${EXT}`;
const BIN_CONTENT = Buffer.from('#!/fake-llama-server\nbytes\n');

// Always-accept signature stub so the test never spawns powershell/codesign.
const verifyOverride = async () => ({ result: { status: 'unsigned' as const }, accepted: true });

let server: Server;
let base: string;
let archiveBytes: Buffer;
let sumsBytes: Buffer;
let sumsDigest: string;
let serveTamperedArchive = false;

async function buildArchive(): Promise<Buffer> {
  if (IS_WIN) {
    const zip = new AdmZip();
    zip.addFile(BIN, BIN_CONTENT);
    return zip.toBuffer();
  }
  const stage = await mkdtemp(join(tmpdir(), 'engine-archive-'));
  await writeFile(join(stage, BIN), BIN_CONTENT);
  const file = join(stage, 'a.tgz');
  await tar.create({ gzip: true, file, cwd: stage }, [BIN]);
  const bytes = await readFile(file);
  await rm(stage, { recursive: true, force: true });
  return bytes;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

beforeAll(async () => {
  archiveBytes = await buildArchive();
  sumsBytes = Buffer.from(`${sha(archiveBytes)}  ${ARCHIVE_NAME}\n`, 'utf8');
  sumsDigest = sha(sumsBytes);

  server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url.includes(`/releases/tags/native-v${VERSION}`)) {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          tag_name: `native-v${VERSION}`,
          assets: [
            { name: 'SHA256SUMS', url: `${base}/sums`, size: sumsBytes.length },
            { name: ARCHIVE_NAME, url: `${base}/archive`, size: archiveBytes.length },
          ],
        }),
      );
      return;
    }
    if (url.startsWith('/sums')) {
      res.end(sumsBytes);
      return;
    }
    if (url.startsWith('/archive')) {
      res.end(
        serveTamperedArchive
          ? Buffer.concat([archiveBytes, Buffer.from('tampered')])
          : archiveBytes,
      );
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const savedEnv: Record<string, string | undefined> = {};
afterEach(() => {
  serveTamperedArchive = false;
  for (const k of [
    'GEZEL_LLAMA_SERVER_BIN',
    'GEZEL_NATIVE_BIN_DIR',
    'GEZEL_LLAMA_SERVER_BACKEND',
  ]) {
    if (k in savedEnv) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }
});
function snapshotEnv() {
  for (const k of [
    'GEZEL_LLAMA_SERVER_BIN',
    'GEZEL_NATIVE_BIN_DIR',
    'GEZEL_LLAMA_SERVER_BACKEND',
  ]) {
    savedEnv[k] = process.env[k];
  }
}

async function freshHome() {
  return mkdtemp(join(tmpdir(), 'engine-home-'));
}

describe('resolveEngine — happy path', () => {
  it('downloads, verifies, caches, and stamps the env var', async () => {
    snapshotEnv();
    const home = await freshHome();
    let verifyCalls = 0;
    const countingVerifyOverride = async () => {
      verifyCalls += 1;
      return { result: { status: 'unsigned' as const }, accepted: true };
    };
    try {
      const result = await resolveEngineToCompletion({
        engine: 'llama-server',
        home,
        variant: VARIANT,
        version: VERSION,
        githubApiBase: base,
        token: 'fixture',
        expectedSha256sumsDigest: sumsDigest,
        expectedArchiveSha256: { [ARCHIVE_NAME]: sha(archiveBytes) },
        signaturePolicy: 'off',
        verifyOverride: countingVerifyOverride,
      });
      const expectedPath = join(
        home,
        'engines',
        'native-bin',
        VERSION,
        `${PLATFORM_KEY}-${VARIANT}`,
        BIN,
      );
      expect(result.binPath).toBe(expectedPath);
      expect(result.cached).toBe(false);
      expect(existsSync(expectedPath)).toBe(true);
      expect((await readFile(expectedPath)).equals(BIN_CONTENT)).toBe(true);
      expect(process.env.GEZEL_LLAMA_SERVER_BIN).toBe(expectedPath);
      expect(process.env.GEZEL_LLAMA_SERVER_BACKEND).toBe(VARIANT);

      // Second resolve hits the fast path.
      const again = await resolveEngineToCompletion({
        engine: 'llama-server',
        home,
        variant: VARIANT,
        version: VERSION,
        githubApiBase: base,
        token: 'fixture',
        expectedSha256sumsDigest: sumsDigest,
        expectedArchiveSha256: { [ARCHIVE_NAME]: sha(archiveBytes) },
        signaturePolicy: 'off',
        verifyOverride: countingVerifyOverride,
      });
      expect(again.cached).toBe(true);
      expect(verifyCalls).toBe(2);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('resolveEngine — verification', () => {
  it('rejects a tampered archive (sha mismatch)', async () => {
    snapshotEnv();
    serveTamperedArchive = true;
    const home = await freshHome();
    try {
      await expect(
        resolveEngineToCompletion({
          engine: 'llama-server',
          home,
          variant: VARIANT,
          version: VERSION,
          githubApiBase: base,
          token: 'fixture',
          expectedSha256sumsDigest: sumsDigest,
          signaturePolicy: 'off',
          verifyOverride,
        }),
      ).rejects.toThrow(/integrity check/i);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('rejects when the pinned SHA256SUMS digest does not match', async () => {
    snapshotEnv();
    const home = await freshHome();
    try {
      await expect(
        resolveEngineToCompletion({
          engine: 'llama-server',
          home,
          variant: VARIANT,
          version: VERSION,
          githubApiBase: base,
          token: 'fixture',
          expectedSha256sumsDigest: 'a'.repeat(64), // wrong pin
          signaturePolicy: 'off',
          verifyOverride,
        }),
      ).rejects.toThrow(/SHA256SUMS digest mismatch/i);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('rejects when SHA256SUMS disagrees with the bundled archive checksum', async () => {
    snapshotEnv();
    const home = await freshHome();
    try {
      await expect(
        resolveEngineToCompletion({
          engine: 'llama-server',
          home,
          variant: VARIANT,
          version: VERSION,
          githubApiBase: base,
          token: 'fixture',
          expectedSha256sumsDigest: sumsDigest,
          expectedArchiveSha256: { [ARCHIVE_NAME]: 'f'.repeat(64) },
          signaturePolicy: 'off',
          verifyOverride,
        }),
      ).rejects.toThrow(/archive checksum mismatch/i);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('defaults first-party binaries to required publisher validation', async () => {
    snapshotEnv();
    const home = await freshHome();
    let observed:
      | {
          policy: string;
          expectedPublisher?: string;
        }
      | undefined;
    try {
      await resolveEngineToCompletion({
        engine: 'llama-server',
        home,
        variant: VARIANT,
        version: VERSION,
        githubApiBase: base,
        token: 'fixture',
        expectedSha256sumsDigest: sumsDigest,
        expectedArchiveSha256: { [ARCHIVE_NAME]: sha(archiveBytes) },
        verifyOverride: async (_path, opts) => {
          observed = opts;
          return { result: { status: 'valid' }, accepted: true };
        },
      });
      expect(observed).toMatchObject({
        policy: 'require',
        expectedPublisher: 'Bendyline LLC',
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('rejects when signature policy rejects the binary', async () => {
    snapshotEnv();
    const home = await freshHome();
    try {
      await expect(
        resolveEngineToCompletion({
          engine: 'llama-server',
          home,
          variant: VARIANT,
          version: VERSION,
          githubApiBase: base,
          token: 'fixture',
          expectedSha256sumsDigest: sumsDigest,
          signaturePolicy: 'require',
          verifyOverride: async () => ({ result: { status: 'invalid' as const }, accepted: false }),
        }),
      ).rejects.toThrow(/signature policy/i);
      // Nothing published on rejection.
      expect(
        existsSync(join(home, 'engines', 'native-bin', VERSION, `${PLATFORM_KEY}-${VARIANT}`, BIN)),
      ).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('resolveEngine — availability gates', () => {
  it('treats an explicit version override as unpinned unless its digest is supplied', async () => {
    snapshotEnv();
    const home = await freshHome();
    try {
      const result = await resolveEngineToCompletion({
        engine: 'llama-server',
        home,
        variant: VARIANT,
        version: VERSION,
        githubApiBase: base,
        token: 'fixture',
        signaturePolicy: 'off',
        verifyOverride,
      });
      expect(result.cached).toBe(false);
      expect(existsSync(result.binPath)).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('refuses to download when unpinned and no override is given', async () => {
    snapshotEnv();
    const prior = process.env.GEZEL_NATIVE_ENGINE_VERSION;
    delete process.env.GEZEL_NATIVE_ENGINE_VERSION;
    const home = await freshHome();
    try {
      await expect(
        resolveEngineToCompletion({
          engine: 'llama-server',
          home,
          variant: VARIANT,
          githubApiBase: base,
          token: 'fixture',
        }),
      ).rejects.toThrow(EngineUnavailableError);
    } finally {
      if (prior !== undefined) process.env.GEZEL_NATIVE_ENGINE_VERSION = prior;
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('impliedEngineVariant', () => {
  it('derives -metal for llama-server on macOS (the only darwin build)', () => {
    // Wild-caught: `POST /api/engines/binaries/llama-server/ensure` with no
    // variant extracted the bare darwin-arm64 archive and failed with
    // "none of [gezel-llama-server, llama-server] were inside it".
    expect(impliedEngineVariant('llama-server', 'darwin')).toBe('metal');
  });

  it('derives -cuda for ds4-server on Linux, but not on macOS', () => {
    expect(impliedEngineVariant('ds4-server', 'linux')).toBe('cuda');
    expect(impliedEngineVariant('ds4-server', 'darwin')).toBeUndefined();
  });

  it('leaves llama-server variant to the caller where it is a real choice', () => {
    expect(impliedEngineVariant('llama-server', 'linux')).toBeUndefined();
    expect(impliedEngineVariant('llama-server', 'win32')).toBeUndefined();
  });

  it('implies nothing for engines that ship in the bare archive', () => {
    for (const engine of ['sd-server', 'whisper-server', 'uv'] as const) {
      expect(impliedEngineVariant(engine, 'darwin')).toBeUndefined();
      expect(impliedEngineVariant(engine, 'linux')).toBeUndefined();
    }
  });
});
