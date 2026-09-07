import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gildeDataDir } from '@bendyline/gezel-catalog';
import { sharedToolsetsFile } from '@bendyline/gezel/paths';

export interface DocblocksEvalProvenance {
  installPath: string;
  packageVersion: string;
  catalogVersion: string;
  entry: string;
  entrySha256: string;
}

/** Explicit operator opt-in for testing a sibling CLI; never affects a product daemon. */
export async function seedDocblocksRuntime(
  trialHome: string,
  packageDir: string,
  log: (message: string) => void,
): Promise<DocblocksEvalProvenance> {
  const installPath = await realpath(packageDir);
  const pkg = JSON.parse(await readFile(join(installPath, 'package.json'), 'utf8'));
  if (pkg.name !== '@bendyline/docblocks-cli') {
    throw new Error(
      'GEZEL_EVAL_DOCBLOCKS_DIR must name the built @bendyline/docblocks-cli package',
    );
  }
  const index = JSON.parse(await readFile(join(gildeDataDir(), 'toolsets/index.json'), 'utf8'));
  const manifest = index.entries.find(
    (entry: { manifest: { id: string } }) => entry.manifest.id === 'docblocks',
  )?.manifest;
  if (!manifest || manifest.runtime.kind !== 'npm-package') {
    throw new Error('Bundled DocBlocks npm runtime is missing');
  }
  const entry = await readFile(join(installPath, manifest.runtime.entry));
  const sha256 = createHash('sha256').update(entry).digest('hex');
  // Shared scope must own the override: scenario setup would otherwise install
  // the published package here and shadow a system-scoped local build.
  const target = sharedToolsetsFile(trialHome);
  const existing = JSON.parse(
    await readFile(target, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '[]';
      throw error;
    }),
  );
  const record = {
    toolsetId: 'docblocks',
    sourceId: 'bundled',
    version: manifest.version,
    installedAt: new Date().toISOString(),
    installPath,
    runtime: manifest.runtime,
  };
  await writeFile(
    target,
    `${JSON.stringify(
      [...existing.filter((item: { toolsetId: string }) => item.toolsetId !== 'docblocks'), record],
      null,
      2,
    )}\n`,
  );
  // Record the actual local build separately from the catalog identity used for routing.
  const provenance = {
    installPath,
    packageVersion: pkg.version,
    catalogVersion: manifest.version,
    entry: manifest.runtime.entry,
    entrySha256: sha256,
  };
  await writeFile(
    join(trialHome, 'docblocks-eval-provenance.json'),
    JSON.stringify(provenance, null, 2),
  );
  log(`[docblocks] local CLI ${installPath}, package=${pkg.version}, entrySha256=${sha256}`);
  return provenance;
}
