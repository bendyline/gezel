#!/usr/bin/env node
/** Generate a flat CycloneDX inventory from pnpm's production license graph. */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { readProductionLicenseInventory } from './production-dependency-inventory.mjs';

const output = resolve(process.argv[2] ?? 'artifacts/gezel.cdx.json');
const rootPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const byLicense = readProductionLicenseInventory();
const components = [];

for (const [license, packages] of Object.entries(byLicense)) {
  for (const pkg of packages) {
    for (const version of pkg.versions) {
      const purl = npmPurl(pkg.name, version);
      const slash = pkg.name.startsWith('@') ? pkg.name.indexOf('/') : -1;
      components.push({
        type: 'library',
        'bom-ref': purl,
        ...(slash > 0 ? { group: pkg.name.slice(0, slash) } : {}),
        name: slash > 0 ? pkg.name.slice(slash + 1) : pkg.name,
        version,
        scope: 'required',
        licenses: [{ license: { name: license } }],
        purl,
      });
    }
  }
}
components.sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref']));

const rootPurl = npmPurl(rootPackage.name, rootPackage.version);
const bom = {
  $schema: 'https://cyclonedx.org/schema/bom-1.6.schema.json',
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: {
      components: [
        {
          type: 'application',
          author: 'Bendyline',
          name: 'gezel-sbom-generator',
          version: '1',
        },
      ],
    },
    component: {
      type: 'application',
      'bom-ref': rootPurl,
      name: rootPackage.name,
      version: rootPackage.version,
      purl: rootPurl,
    },
  },
  components,
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(bom, null, 2)}\n`, { mode: 0o600 });
console.log(`✓ wrote CycloneDX SBOM with ${components.length} components to ${output}`);

function npmPurl(name, version) {
  if (name.startsWith('@')) {
    const [scope, packageName] = name.slice(1).split('/');
    return `pkg:npm/%40${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}
