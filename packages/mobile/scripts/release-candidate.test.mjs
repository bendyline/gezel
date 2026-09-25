import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { withReleaseCandidate } from './release-candidate.mjs';

async function fixture(run) {
  const out = await mkdtemp(path.join(tmpdir(), 'gezel-release-candidate-'));
  try {
    await writeFile(path.join(out, 'gezel-unsigned.apk'), 'old verified bytes');
    await writeFile(path.join(out, 'release-manifest.json'), 'old verified manifest');
    await run(out);
    assert.deepEqual(
      (await readdir(out)).filter((name) => name.startsWith('.')),
      [],
    );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

test('a failed build or verification leaves the last verified release intact', () =>
  fixture(async (out) => {
    await assert.rejects(
      withReleaseCandidate(out, async (stage) => {
        await writeFile(path.join(stage, 'gezel-unsigned.apk'), 'unverified bytes');
        throw new Error('ELF verification failed');
      }),
      /ELF verification failed/,
    );
    assert.equal(
      await readFile(path.join(out, 'gezel-unsigned.apk'), 'utf8'),
      'old verified bytes',
    );
    assert.equal(
      await readFile(path.join(out, 'release-manifest.json'), 'utf8'),
      'old verified manifest',
    );
  }));

test('publishes all verified artifacts and rewrites manifest references to their final paths', () =>
  fixture(async (out) => {
    await withReleaseCandidate(out, async (stage) => {
      const artifacts = [];
      for (const name of ['gezel-unsigned.apk', 'gezel-unsigned.aab']) {
        const file = path.join(stage, name);
        await writeFile(file, `verified ${name}`);
        artifacts.push({
          path: file,
          sha256: name,
          verification: { archive: file, productionAssets: 'passed' },
        });
      }
      return { unsigned: true, artifacts };
    });
    const manifest = JSON.parse(await readFile(path.join(out, 'release-manifest.json'), 'utf8'));
    for (const artifact of manifest.artifacts) {
      assert.equal(path.dirname(artifact.path), out);
      assert.equal(artifact.verification.archive, artifact.path);
      assert.equal(
        await readFile(artifact.path, 'utf8'),
        `verified ${path.basename(artifact.path)}`,
      );
    }
  }));

test('rejects incomplete or escaped manifests before touching the old release', () =>
  fixture(async (out) => {
    for (const kind of ['missing', 'escape', 'empty']) {
      await assert.rejects(
        withReleaseCandidate(out, async (stage) => ({
          artifacts:
            kind === 'empty'
              ? []
              : [
                  {
                    path:
                      kind === 'escape'
                        ? path.join(out, 'gezel-unsigned.apk')
                        : path.join(stage, 'missing.apk'),
                  },
                ],
        })),
      );
      assert.equal(
        await readFile(path.join(out, 'release-manifest.json'), 'utf8'),
        'old verified manifest',
      );
    }
  }));

test('serializes release writers and releases the output lock after failure', () =>
  fixture(async (out) => {
    await assert.rejects(
      withReleaseCandidate(out, async () => {
        await assert.rejects(
          withReleaseCandidate(out, async () => {
            throw new Error('must not start');
          }),
          /already locked/,
        );
        await access(path.join(out, '.release.lock'));
        throw new Error('cancel packaging');
      }),
      /cancel packaging/,
    );
    await assert.rejects(access(path.join(out, '.release.lock')));
  }));
