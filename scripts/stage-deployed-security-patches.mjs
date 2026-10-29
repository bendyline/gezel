import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  deployedExceptionInventory,
  readVulnerabilityExceptions,
  verifiesException,
} from './audit-vulnerability-policy.mjs';
import { readProductionLicenseInventory } from './production-dependency-inventory.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Hoisted pnpm deploy can patch one copy but leave nested duplicates at upstream bytes. */
export async function stageDeployedSecurityPatches(
  deploymentRoot,
  {
    exceptions = readVulnerabilityExceptions(),
    inventory = readProductionLicenseInventory(),
    now = new Date(),
  } = {},
) {
  const patched = exceptions.filter((entry) => entry.patchPreimages);
  const deployed = await deployedExceptionInventory(deploymentRoot, patched);
  const writes = [];
  for (const entry of patched) {
    if (!verifiesException(entry, inventory, now))
      throw new Error(`unverified patch source: ${entry.package}`);
    const sources = Object.values(inventory)
      .flat()
      .filter((pkg) => pkg.name === entry.package);
    for (const pkg of deployed.deployed.filter((pkg) => pkg.name === entry.package)) {
      const version = pkg.versions[0];
      const files = version === entry.version ? entry.files : entry.additionalVersions?.[version];
      if (!files) throw new Error(`unreviewed deployed version: ${entry.package}@${version}`);
      const source = sources.find((pkg) => pkg.versions.includes(version));
      if (!source) throw new Error(`missing patch source: ${entry.package}@${version}`);
      const sourceDir = source.paths[source.versions.indexOf(version)];
      for (const [file, expected] of Object.entries(files)) {
        const target = join(pkg.paths[0], file);
        const actual = digest(await readFile(target));
        if (actual === expected) continue;
        if (actual !== entry.patchPreimages[version]?.[file])
          throw new Error(`unknown patch preimage: ${target}`);
        const bytes = await readFile(join(sourceDir, file));
        if (digest(bytes) !== expected) throw new Error(`patch source changed: ${file}`);
        writes.push({ target, bytes });
      }
    }
  }
  for (const { target, bytes } of writes) {
    // Never truncate a pnpm store hardlink: replacing the directory entry isolates the copy.
    const temp = `${target}.gezel-patch-${randomUUID()}`;
    try {
      await writeFile(temp, bytes, { flag: 'wx' });
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true });
    }
  }
  for (const entry of patched) {
    if (!verifiesException(entry, deployed, now))
      throw new Error(`deployed patch proof failed: ${entry.package}`);
  }
  console.log(
    `[security-patches] repaired ${writes.length} verified upstream files in deployed copies`,
  );
  return writes.length;
}
