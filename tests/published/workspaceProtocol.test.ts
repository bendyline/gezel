/**
 * `workspace:*` must never reach npm.
 *
 * Every cross-package dependency in this repo uses pnpm's workspace
 * protocol. `npm publish` does not understand it and would ship a manifest
 * containing a literal `"@bendyline/gezel": "workspace:*"`, which no
 * consumer can install. `pnpm publish`/`pnpm pack` rewrite it to the
 * sibling's concrete version, which is exactly why
 * `scripts/publish-package.mjs` shells out to pnpm instead of letting
 * `@semantic-release/npm` publish.
 *
 * This test packs for real (not `--dry-run`) and reads the manifest back
 * out of the tarball, because the rewrite only happens during packing.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { afterAll, describe, expect, it } from 'vitest';
import { type PackageJson, REPO_ROOT, loadPublishedPackages } from './_packages';

const RUNTIME_DEP_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const;
const workspaceVersions = new Map(
  loadPublishedPackages().map(({ name, pkg }) => [name, pkg.version]),
);

/** Only packages that actually declare a workspace sibling need packing. */
const packages = loadPublishedPackages().filter((p) =>
  RUNTIME_DEP_FIELDS.some((field) =>
    Object.values(p.pkg[field] ?? {}).some((range) => range.startsWith('workspace:')),
  ),
);

const temporaryDirs: string[] = [];
afterAll(() => {
  for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
});

function readPackedManifest(tarball: string): PackageJson {
  let manifest: PackageJson | undefined;
  const chunks: Buffer[] = [];
  tar.list({
    file: tarball,
    sync: true,
    filter: (path) => path === 'package/package.json',
    onReadEntry: (entry) => {
      entry.on('data', (chunk: Buffer) => chunks.push(chunk));
      entry.on('end', () => {
        manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      });
    },
  });

  if (!manifest) throw new Error(`no package.json inside ${tarball}`);
  return manifest;
}

function packedManifests(): Map<string, PackageJson> {
  if (packages.length === 0) return new Map();

  const destination = mkdtempSync(join(tmpdir(), 'gezel-ws-pack-'));
  temporaryDirs.push(destination);

  // Pack every relevant workspace package in one pnpm process. Besides being
  // faster in general, this avoids paying the unusually high CLI cold-start
  // cost once per package on Windows.
  const packArgs = [
    '--recursive',
    ...packages.flatMap(({ name }) => ['--filter', name]),
    'pack',
    '--pack-destination',
    destination,
  ];
  // pnpm is exposed through a .cmd shim on Windows. Node cannot launch
  // command-script shims directly, so invoke it explicitly through cmd.exe.
  const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm';
  const args =
    process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm.cmd', ...packArgs] : packArgs;
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = [result.error?.stack, result.stderr, result.stdout].filter(Boolean).join('\n');
    throw new Error(
      `pnpm pack failed in ${REPO_ROOT} (status=${result.status}, signal=${result.signal}):\n${detail}`,
    );
  }

  const manifests = readdirSync(destination)
    .filter((file) => file.endsWith('.tgz'))
    .map((file) => readPackedManifest(join(destination, file)));
  return new Map(manifests.map((manifest) => [manifest.name, manifest]));
}

const packedByName = packedManifests();

describe('workspace protocol is resolved at pack time', () => {
  it('has packages to check', () => {
    expect(packages.length).toBeGreaterThan(0);
  });

  it.each(packages)(
    '$name ships concrete versions for its workspace siblings',
    ({ name, pkg }) => {
      const packed = packedByName.get(name);
      if (!packed) throw new Error(`pnpm pack produced no tarball for ${name}`);

      for (const field of RUNTIME_DEP_FIELDS) {
        for (const [dep, range] of Object.entries(packed[field] ?? {})) {
          expect(
            range,
            `${packed.name} → ${dep} in ${field} still uses the workspace protocol`,
          ).not.toContain('workspace:');
          const siblingVersion = workspaceVersions.get(dep);
          if (siblingVersion) {
            expect(
              range,
              `${packed.name} → ${dep} in ${field} does not match the sibling tarball version`,
            ).toBe(siblingVersion);
          }
        }
      }

      // Every sibling declared in the source manifest must survive into the
      // packed one — a rewrite that dropped the dependency entirely would
      // also satisfy the assertion above.
      for (const field of RUNTIME_DEP_FIELDS) {
        for (const dep of Object.keys(pkg[field] ?? {})) {
          expect(
            packed[field]?.[dep],
            `${packed.name} lost ${dep} from ${field} while packing`,
          ).toBeTruthy();
        }
      }
    },
    120_000,
  );
});
