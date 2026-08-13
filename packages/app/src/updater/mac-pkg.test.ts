import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPLE_TEAM_ID,
  PkgVerificationError,
  macPkgAssetName,
  parseSha256Sums,
  releaseAssetUrl,
  stageVerifiedMacPkg,
  verifyMacPkg,
} from './mac-pkg.js';

const PKG_BYTES = Buffer.from('pretend this is a 450 MB installer');
// sha256 of PKG_BYTES, computed the same way the implementation does.
const PKG_SHA = await import('node:crypto').then((c) =>
  c.createHash('sha256').update(PKG_BYTES).digest('hex'),
);

/** A `pkgutil --check-signature` transcript for a good package. */
function goodSignature(team = APPLE_TEAM_ID): string {
  return [
    'Package "Gezel-1.2.3-mac-arm64.pkg":',
    '   Status: signed by a developer certificate issued by Apple for distribution',
    '   Notarization: trusted by the Apple notary service',
    '   Certificate Chain:',
    `    1. Developer ID Installer: Bendyline, LLC (${team})`,
    '    2. Developer ID Certification Authority',
    '    3. Apple Root CA',
  ].join('\n');
}

interface ExecResult {
  stdout: string;
  stderr?: string;
}

function execStub(
  overrides: {
    pkgutil?: string | Error;
    spctl?: ExecResult | Error;
  } = {},
) {
  return vi.fn(async (file: string) => {
    if (file.endsWith('pkgutil')) {
      const v = overrides.pkgutil ?? goodSignature();
      if (v instanceof Error) throw v;
      return { stdout: v };
    }
    if (file.endsWith('spctl')) {
      const v = overrides.spctl ?? {
        stdout: '',
        stderr: 'Gezel.pkg: accepted\nsource=Notarized Developer ID',
      };
      if (v instanceof Error) throw v;
      return v;
    }
    throw new Error(`unexpected exec: ${file}`);
  });
}

describe('release asset naming', () => {
  it('matches the electron-builder mac artifactName template', () => {
    expect(macPkgAssetName('1.26211.23')).toBe('Gezel-1.26211.23-mac-arm64.pkg');
  });

  it('points at the tagged GitHub release', () => {
    expect(releaseAssetUrl('1.26211.23', 'SHA256SUMS')).toBe(
      'https://github.com/bendyline/gezel/releases/download/v1.26211.23/SHA256SUMS',
    );
  });
});

describe('parseSha256Sums', () => {
  it('reads plain sha256sum output', () => {
    const map = parseSha256Sums(
      `${'a'.repeat(64)}  Gezel-1.2.3-mac-arm64.pkg\n${'b'.repeat(64)}  SHA256SUMS\n`,
    );
    expect(map.get('Gezel-1.2.3-mac-arm64.pkg')).toBe('a'.repeat(64));
  });

  it('tolerates the binary-mode asterisk and ignores junk lines', () => {
    const map = parseSha256Sums(`# comment\n${'c'.repeat(64)} *thing.pkg\nnot a line\n`);
    expect(map.get('thing.pkg')).toBe('c'.repeat(64));
    expect(map.size).toBe(1);
  });
});

describe('verifyMacPkg', () => {
  const deps = () => ({ execFile: execStub(), logger: { info: vi.fn(), warn: vi.fn() } });

  it('accepts the real spctl shape: exit 0 with the verdict on stderr', async () => {
    await expect(verifyMacPkg('/tmp/x.pkg', 'abc', 'abc', deps())).resolves.toBeUndefined();
  });

  it('uses Gatekeeper exit status instead of parsing localized output', async () => {
    const d = {
      execFile: execStub({
        spctl: { stdout: '', stderr: 'Paket akzeptiert\nQuelle=Notarisierte Entwickler-ID' },
      }),
      logger: {},
    };
    await expect(verifyMacPkg('/tmp/x.pkg', 'a', 'a', d)).resolves.toBeUndefined();
  });

  it('rejects a digest mismatch before running any Apple check', async () => {
    const d = deps();
    await expect(verifyMacPkg('/tmp/x.pkg', 'expected', 'actual', d)).rejects.toThrow(
      PkgVerificationError,
    );
    expect(d.execFile).not.toHaveBeenCalled();
  });

  it('rejects an unsigned package', async () => {
    const d = {
      execFile: execStub({ pkgutil: 'Package "x.pkg":\n   Status: no signature' }),
      logger: {},
    };
    await expect(verifyMacPkg('/tmp/x.pkg', 'a', 'a', d)).rejects.toMatchObject({
      step: 'signature',
    });
  });

  it('rejects a signed-but-not-notarized package', async () => {
    const stdout = goodSignature().replace(
      '   Notarization: trusted by the Apple notary service\n',
      '',
    );
    const d = { execFile: execStub({ pkgutil: stdout }), logger: {} };
    await expect(verifyMacPkg('/tmp/x.pkg', 'a', 'a', d)).rejects.toMatchObject({
      step: 'notarization',
    });
  });

  // The case the team pin exists for: a package that is genuinely
  // Developer ID-signed and notarized, just not by us.
  it('rejects a valid package signed by a different Apple team', async () => {
    const d = { execFile: execStub({ pkgutil: goodSignature('AAAAAAAAAA') }), logger: {} };
    await expect(verifyMacPkg('/tmp/x.pkg', 'a', 'a', d)).rejects.toMatchObject({ step: 'team' });
  });

  it('rejects when Gatekeeper says no, including via a non-zero exit', async () => {
    const rejection = Object.assign(new Error('exit 3'), {
      stderr: 'x.pkg: rejected\nsource=no usable signature',
    });
    const d = { execFile: execStub({ spctl: rejection }), logger: {} };
    const verification = verifyMacPkg('/tmp/x.pkg', 'a', 'a', d);
    await expect(verification).rejects.toMatchObject({
      step: 'gatekeeper',
    });
    await expect(verification).rejects.toThrow(/rejected[\s\S]*no usable signature/i);
  });
});

describe('stageVerifiedMacPkg', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-pkg-stage-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function fetchStub(
    sums: string,
    pkg: Buffer | null = PKG_BYTES,
    arrayBuffer = vi.fn(async () => {
      throw new Error('arrayBuffer must not be used for package downloads');
    }),
  ): typeof globalThis.fetch {
    return vi.fn(async (url: string | URL | Request) => {
      const href = String(url instanceof Request ? url.url : url);
      if (href.endsWith('SHA256SUMS')) {
        return { ok: true, status: 200, text: async () => sums } as unknown as Response;
      }
      if (!pkg) return { ok: false, status: 404 } as unknown as Response;
      return {
        ok: true,
        status: 200,
        body: bufferStream(pkg),
        arrayBuffer,
      } as unknown as Response;
    });
  }

  it('stages a verified package and returns its path', async () => {
    const arrayBuffer = vi.fn(async () => {
      throw new Error('arrayBuffer must not be used for package downloads');
    });
    const result = await stageVerifiedMacPkg('1.2.3', {
      fetch: fetchStub(`${PKG_SHA}  Gezel-1.2.3-mac-arm64.pkg\n`, PKG_BYTES, arrayBuffer),
      execFile: execStub(),
      stagingDir: dir,
      logger: { info: vi.fn() },
    });

    expect(result.path).toBe(join(dir, 'Gezel-1.2.3-mac-arm64.pkg'));
    expect(result.sha256).toBe(PKG_SHA);
    expect(await readFile(result.path)).toEqual(PKG_BYTES);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect((await readdir(dir)).filter((name) => name.includes('.partial-'))).toEqual([]);
  });

  it('verifies a hidden partial before atomically exposing the final package path', async () => {
    const pkgPath = join(dir, 'Gezel-1.2.3-mac-arm64.pkg');
    const checkedPaths: string[] = [];
    const execFile = vi.fn(async (file: string, args: string[]) => {
      const checkedPath = args.at(-1)!;
      checkedPaths.push(checkedPath);
      expect(checkedPath).not.toBe(pkgPath);
      expect(checkedPath).toMatch(/[\\/]\.[^\\/]+\.partial-Gezel-.*\.pkg$/);
      await expect(readFile(pkgPath)).rejects.toMatchObject({ code: 'ENOENT' });
      return file.endsWith('pkgutil')
        ? { stdout: goodSignature() }
        : { stdout: '', stderr: 'accepted' };
    });

    const result = await stageVerifiedMacPkg('1.2.3', {
      fetch: fetchStub(`${PKG_SHA}  Gezel-1.2.3-mac-arm64.pkg\n`),
      execFile,
      stagingDir: dir,
    });

    expect(checkedPaths).toHaveLength(2);
    expect(result.path).toBe(pkgPath);
    expect(await readFile(pkgPath)).toEqual(PKG_BYTES);
  });

  it('cleans a partial stream and retries the download from byte zero', async () => {
    let pkgRequests = 0;
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url instanceof Request ? url.url : url);
      if (href.endsWith('SHA256SUMS')) {
        return {
          ok: true,
          status: 200,
          text: async () => `${PKG_SHA}  Gezel-1.2.3-mac-arm64.pkg\n`,
        } as unknown as Response;
      }
      pkgRequests++;
      return {
        ok: true,
        status: 200,
        body: pkgRequests === 1 ? failingStream(PKG_BYTES.subarray(0, 8)) : bufferStream(PKG_BYTES),
      } as unknown as Response;
    }) as typeof globalThis.fetch;

    const result = await stageVerifiedMacPkg('1.2.3', {
      fetch,
      execFile: execStub(),
      stagingDir: dir,
    });

    expect(pkgRequests).toBe(2);
    expect(await readFile(result.path)).toEqual(PKG_BYTES);
    expect((await readdir(dir)).filter((name) => name.includes('.partial-'))).toEqual([]);
  });

  it('refuses a release that publishes no digest for our asset', async () => {
    await expect(
      stageVerifiedMacPkg('1.2.3', {
        fetch: fetchStub(`${'d'.repeat(64)}  something-else.pkg\n`),
        execFile: execStub(),
        stagingDir: dir,
      }),
    ).rejects.toThrow(/publishes no digest/);
  });

  it('deletes the download when verification fails, so no unverified installer is left behind', async () => {
    const pkgPath = join(dir, 'Gezel-1.2.3-mac-arm64.pkg');
    await expect(
      stageVerifiedMacPkg('1.2.3', {
        // A digest that does not describe the bytes we serve.
        fetch: fetchStub(`${'e'.repeat(64)}  Gezel-1.2.3-mac-arm64.pkg\n`),
        execFile: execStub(),
        stagingDir: dir,
      }),
    ).rejects.toMatchObject({ step: 'digest' });

    await expect(readFile(pkgPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(dir)).filter((name) => name.includes('.partial-'))).toEqual([]);
  });

  it('does not leave a stale package behind when the signature check fails', async () => {
    const pkgPath = join(dir, 'Gezel-1.2.3-mac-arm64.pkg');
    await writeFile(pkgPath, 'stale bytes from a previous run');

    await expect(
      stageVerifiedMacPkg('1.2.3', {
        fetch: fetchStub(`${PKG_SHA}  Gezel-1.2.3-mac-arm64.pkg\n`),
        execFile: execStub({ pkgutil: goodSignature('AAAAAAAAAA') }),
        stagingDir: dir,
      }),
    ).rejects.toMatchObject({ step: 'team' });

    await expect(readFile(pkgPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(dir)).filter((name) => name.includes('.partial-'))).toEqual([]);
  });
});

/** Deliver a buffer in several chunks so the streaming path is exercised. */
function bufferStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const chunkSize = Math.max(1, Math.ceil(bytes.byteLength / 3));
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.byteLength, offset + chunkSize);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}

/** Emit one partial chunk, then reproduce Undici's transient stream failure. */
function failingStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let emitted = false;
  return new ReadableStream({
    pull(controller) {
      if (!emitted) {
        emitted = true;
        controller.enqueue(bytes);
        return;
      }
      controller.error(new TypeError('terminated'));
    },
  });
}
