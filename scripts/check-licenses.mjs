#!/usr/bin/env node
/**
 * License audit.
 *
 * Runs `pnpm licenses list --prod --json` over every production
 * dependency in the workspace and fails if any package carries a license
 * outside the permissive allowlist or a narrowly reviewed redistribution
 * exception. Packages whose license pnpm reports as `Unknown` must be listed
 * in `KNOWN_UNKNOWN` with a justifying
 * comment — otherwise the audit fails.
 *
 * Run locally: `pnpm audit:licenses`
 * In CI:       same command; non-zero exit means a policy violation.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProductionLicenseInventory } from './production-dependency-inventory.mjs';

/**
 * The installer EULA names the non-permissive components by license so a
 * user can see what they are agreeing to before the app is on disk. That
 * list is prose, so nothing stops it drifting when a new copyleft
 * dependency is reviewed in here — which is exactly how it went stale
 * before. Every license in REVIEWED_NON_PERMISSIVE must be named there.
 */
const EULA_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../packages/app/EULA.txt');

/**
 * Permissive licenses Gezel accepts without review. Everything in this
 * set is either a standard permissive (MIT, BSD variants, ISC, 0BSD,
 * Unlicense, CC0) or a multi-licensed expression that includes one.
 *
 * When adding to this list, prefer the exact string pnpm reports (it
 * mirrors the upstream `package.json` `license` field verbatim,
 * including parentheses and spacing).
 */
const ALLOWED = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Python-2.0',
  'Unlicense',
  'Zlib',
  // Multi-licensed expressions — accepted because at least one leg is
  // permissive and we choose the permissive leg by policy.
  '(BSD-2-Clause OR MIT OR Apache-2.0)',
  '(CC-BY-4.0 AND OFL-1.1 AND MIT)',
  '(MIT AND Zlib)',
  '(MIT OR EUPL-1.1+)',
  '(MIT OR GPL-3.0-or-later)',
  '(MPL-2.0 OR Apache-2.0)',
  '(MIT OR Apache-2.0)',
  '(MIT OR CC0-1.0)',
  '(MIT OR WTFPL)',
  'Apache-2.0 OR MIT',
  'MIT OR Apache-2.0',
  // sqlite-vec publishes this non-SPDX spelling; both choices are permissive.
  'MIT OR Apache',
]);

/**
 * Packages that legitimately report `Unknown` to pnpm — typically because
 * the upstream `package.json` uses a non-SPDX `license` shape (e.g. a
 * `licenses: [...]` array, or a file pointer) that pnpm can't normalize.
 * Each entry here is a note to a future auditor: we looked, we know
 * what the license is, we accepted it.
 */
const KNOWN_UNKNOWN = {
  '@github/copilot':
    'PROPRIETARY — "GitHub Copilot CLI License" (see LICENSE.md in the package). ' +
    'Permitted for redistribution only as part of an application or service with ' +
    'material functionality beyond the Software itself (Gezel qualifies); modification ' +
    'and standalone distribution are not permitted. NOTICE.md carries the attribution ' +
    'notice the license requires. Ship-time checklist: do NOT vendor this package into ' +
    'a standalone distribution, and do NOT modify its binaries.',
  '@github/copilot-darwin-arm64':
    'macOS/arm64 prebuilt binary for @github/copilot — same proprietary license as the parent package.',
  '@github/copilot-darwin-x64':
    'macOS/x64 prebuilt binary for @github/copilot — same proprietary license as the parent package.',
  '@github/copilot-linux-arm64':
    'Linux/arm64 prebuilt binary for @github/copilot — same proprietary license as the parent package.',
  '@github/copilot-linux-x64':
    'Linux/x64 prebuilt binary for @github/copilot — same proprietary license as the parent package.',
  '@github/copilot-win32-x64':
    'Windows/x64 prebuilt binary for @github/copilot — same proprietary license as the parent package.',
  flatbuffers:
    'Apache-2.0 per https://github.com/google/flatbuffers/blob/master/LICENSE. ' +
    'The npm package uses a non-SPDX `licenses: [{type: "Apache-2.0", ...}]` shape which ' +
    'pnpm reports as Unknown.',
  khroma:
    'MIT; the khroma@2.1.0 tarball includes the standard MIT text in its `license` file ' +
    'but omits package.json license metadata.',
  'valid-url':
    'MIT; valid-url@1.0.9 includes the standard MIT text in `LICENSE` but omits ' +
    'package.json license metadata.',
};

/**
 * Non-permissive dependencies approved for redistribution as unmodified
 * upstream artifacts inside the Gezel application. These exceptions are
 * intentionally scoped to an exact license and version: an upgrade, license
 * change, or unrelated package using the same license must be reviewed again.
 */
const REVIEWED_NON_PERMISSIVE = [
  {
    name: /^@resvg\/resvg-js(?:-.+)?$/,
    versions: new Set(['2.6.2']),
    license: 'MPL-2.0',
    rationale: 'Unmodified resvg runtime and platform binary distributed as part of the Gezel app.',
  },
];

function run() {
  const byLicense = readProductionLicenseInventory();
  const offenders = [];

  for (const [license, packages] of Object.entries(byLicense)) {
    if (license === 'Unknown') {
      for (const pkg of packages) {
        if (!(pkg.name in KNOWN_UNKNOWN)) {
          offenders.push({
            reason: 'license=Unknown and not on the KNOWN_UNKNOWN list',
            name: pkg.name,
            versions: pkg.versions,
            license,
          });
        }
      }
      continue;
    }
    if (!ALLOWED.has(license)) {
      for (const pkg of packages) {
        if (reviewedNonPermissive(pkg.name, pkg.versions, license)) continue;
        offenders.push({
          reason: `license "${license}" is neither permissive nor an exact reviewed exception`,
          name: pkg.name,
          versions: pkg.versions,
          license,
        });
      }
    }
  }

  const eulaGaps = eulaCoverageGaps();
  if (eulaGaps.length > 0) {
    console.error(
      `✗ license audit failed — the installer EULA does not name ${eulaGaps.length} reviewed non-permissive license(s):`,
    );
    for (const gap of eulaGaps) {
      console.error(`  - ${gap.license} (${gap.packages})`);
    }
    console.error('');
    console.error(`Users agree to ${EULA_PATH} at install time, before NOTICE.md exists on disk,`);
    console.error(
      'so a component whose terms differ from the MIT License has to be named there too.',
    );
    console.error('Add it to the "Third-party components included with Gezel" section.');
    process.exit(1);
  }

  if (offenders.length === 0) {
    const totalPackages = Object.values(byLicense).reduce((n, pkgs) => n + pkgs.length, 0);
    const totalLicenses = Object.keys(byLicense).length;
    console.log(
      `\u2713 license audit passed — ${totalPackages} packages across ${totalLicenses} distinct license expressions.`,
    );
    console.log(`  Allowlist: ${[...ALLOWED].sort().join(', ')}`);
    const knownCount = Object.keys(KNOWN_UNKNOWN).length;
    if (knownCount > 0) {
      console.log(
        `  ${knownCount} pre-approved "Unknown" packages skipped (see KNOWN_UNKNOWN in this script).`,
      );
    }
    console.log(
      `  ${REVIEWED_NON_PERMISSIVE.length} package-scoped non-permissive rules reviewed (see REVIEWED_NON_PERMISSIVE in this script).`,
    );
    process.exit(0);
  }

  console.error(`\u2717 license audit failed — ${offenders.length} offender(s):`);
  for (const o of offenders) {
    console.error(`  - ${o.name}@${o.versions.join(',')}: ${o.reason}`);
  }
  console.error('');
  console.error('To fix:');
  console.error(
    '  1. If the license really is permissive, add its exact pnpm-reported string to ALLOWED in scripts/check-licenses.mjs.',
  );
  console.error(
    '  2. If a package reports `Unknown` but its upstream license is permissive, add it to KNOWN_UNKNOWN with a justification.',
  );
  console.error(
    '  3. If redistribution has been reviewed, add a package-, version-, and license-scoped rule to REVIEWED_NON_PERMISSIVE.',
  );
  console.error('  4. Otherwise replace the dependency.');
  process.exit(1);
}

/**
 * Reviewed non-permissive licenses the EULA fails to mention. Matches on
 * the SPDX identifier rather than the package name — the EULA describes
 * components in prose ("the resvg SVG renderer"), but every
 * entry states its license verbatim, which is the part that must not
 * drift.
 */
function eulaCoverageGaps() {
  let eula;
  try {
    eula = readFileSync(EULA_PATH, 'utf8');
  } catch (err) {
    console.error(`✗ could not read the installer EULA at ${EULA_PATH}: ${err.message}`);
    process.exit(1);
  }
  const gaps = [];
  for (const license of new Set(REVIEWED_NON_PERMISSIVE.map((rule) => rule.license))) {
    if (eula.includes(license)) continue;
    const packages = REVIEWED_NON_PERMISSIVE.filter((rule) => rule.license === license)
      .map((rule) => String(rule.name))
      .join(', ');
    gaps.push({ license, packages });
  }
  return gaps;
}

function reviewedNonPermissive(name, versions, license) {
  return REVIEWED_NON_PERMISSIVE.some(
    (review) =>
      review.name.test(name) &&
      review.license === license &&
      versions.length > 0 &&
      versions.every((version) => review.versions.has(version)),
  );
}

run();
