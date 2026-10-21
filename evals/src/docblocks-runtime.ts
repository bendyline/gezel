import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gildeDataDir } from '@bendyline/gezel-catalog';
import { bundledDocblocksToolset, ensureDocblocksBrowser } from '@bendyline/gezel-service';
import { playwrightBrowsersDir, sharedToolsetsFile } from '@bendyline/gezel/paths';

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

/**
 * Give a trial home the headless browser DocBlocks previews launch.
 *
 * DocBlocks is bundled, so any trial may call `preview_document`, but a trial
 * home is fresh and skips the system bootstrap that installs its browser.
 * The home's managed browsers folder links to one folder in the eval cache,
 * filled once by the installer the product uses. A failed download is
 * logged and the trial still runs: previews then report themselves
 * unavailable, as on a machine without the browser.
 */
export async function seedDocblocksBrowser(opts: {
  trialHome: string;
  cacheRoot: string;
  /** A local DocBlocks build under test; defaults to the bundled one. */
  docblocksInstallPath?: string;
  log: (message: string) => void;
}): Promise<boolean> {
  const shared = join(opts.cacheRoot, 'playwright-browsers');
  await mkdir(shared, { recursive: true });
  const installPath = opts.docblocksInstallPath ?? bundledDocblocksToolset().installPath;
  if (!installPath) throw new Error('the bundled DocBlocks has no install path');
  const result = await ensureDocblocksBrowser({
    docblocksInstallPath: installPath,
    browsersDir: shared,
  });
  if (result.installed) opts.log(`[docblocks] installed the preview browser into ${shared}`);
  if (!result.ok) opts.log(`[docblocks] preview browser unavailable: ${result.error}`);
  await symlink(shared, playwrightBrowsersDir(opts.trialHome), 'junction').catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  return result.ok;
}
