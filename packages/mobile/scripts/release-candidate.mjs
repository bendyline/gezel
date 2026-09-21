import { lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Failed builds preserve the last verified release. A manifest is the commit
 * marker: remove it before replacing artifacts, publish it last, and serialize
 * writers so concurrent packaging cannot certify a mixed set of files. */
export async function withReleaseCandidate(out, build) {
  await mkdir(out, { recursive: true });
  const lockPath = path.join(out, '.release.lock');
  let lock;
  try {
    lock = await open(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(
        `Release output is already locked: ${lockPath}. Check the recorded process before removing a stale lock.`,
      );
    throw error;
  }
  let stage;
  try {
    await lock.writeFile(
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    );
    stage = await mkdtemp(path.join(out, '.candidate-'));
    const manifest = await build(stage);
    if (!manifest.artifacts?.length)
      throw new Error('The release candidate has no verified artifacts.');
    const names = new Set();
    const artifacts = [];
    for (const item of manifest.artifacts) {
      const name = path.basename(item.path);
      if (path.dirname(item.path) !== stage || names.has(name) || name.startsWith('.'))
        throw new Error(
          'Release artifacts must be distinct direct children of the candidate directory.',
        );
      names.add(name);
      const file = await lstat(item.path);
      if (file.isSymbolicLink() || (!file.isFile() && !file.isDirectory()))
        throw new Error(`Unsupported release artifact: ${name}`);
      const finalPath = path.join(out, name);
      artifacts.push({
        ...item,
        path: finalPath,
        verification: item.verification ? { ...item.verification, archive: finalPath } : undefined,
      });
    }
    const finalManifest = { ...manifest, artifacts };
    const stagedManifest = path.join(stage, 'release-manifest.json');
    await writeFile(stagedManifest, `${JSON.stringify(finalManifest, null, 2)}\n`);
    // From this point an interrupted publication must have no success marker.
    await rm(path.join(out, 'release-manifest.json'), { force: true });
    for (const name of names) {
      await rm(path.join(out, name), { recursive: true, force: true });
      await rename(path.join(stage, name), path.join(out, name));
    }
    await rename(stagedManifest, path.join(out, 'release-manifest.json'));
    return finalManifest;
  } finally {
    try {
      if (stage) await rm(stage, { recursive: true, force: true });
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }
}
