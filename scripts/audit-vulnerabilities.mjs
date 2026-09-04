#!/usr/bin/env node
/** Audit exact production versions through npm's current bulk advisory API. */

import { requestAdvisories } from './audit-vulnerabilities-lib.mjs';
import {
  packageVersionsFromInventory,
  readProductionLicenseInventory,
} from './production-dependency-inventory.mjs';

const levels = ['info', 'low', 'moderate', 'high', 'critical'];
const requestedLevel = valueAfter('--audit-level') ?? 'high';
const threshold = levels.indexOf(requestedLevel);
if (threshold < 0) {
  throw new Error(`invalid --audit-level ${JSON.stringify(requestedLevel)}`);
}

const packages = packageVersionsFromInventory(readProductionLicenseInventory());
const advisories = await requestAdvisories(packages);
const failing = advisories.filter((advisory) => severityOf(advisory) >= threshold);

if (advisories.length === 0) {
  console.log(`✓ vulnerability audit passed — ${Object.keys(packages).length} production packages`);
  process.exit(0);
}
for (const advisory of advisories) {
  const severity = String(advisory.severity ?? 'unknown');
  const id = String(advisory.id ?? 'unknown');
  const name = String(advisory.name ?? 'unknown');
  const installed = packages[name]?.join(', ') ?? 'unknown';
  const affected =
    typeof advisory.vulnerable_versions === 'string'
      ? `; advisory range: ${advisory.vulnerable_versions}`
      : '';
  const title = String(advisory.title ?? 'untitled advisory');
  const url = typeof advisory.url === 'string' ? ` ${advisory.url}` : '';
  console.log(
    `- [${severity}] ${name} (installed: ${installed}${affected}): ${title} (${id})${url}`,
  );
}
if (failing.length > 0) {
  console.error(
    `✗ vulnerability audit failed — ${failing.length} advisory(s) at or above ${requestedLevel}`,
  );
  process.exit(1);
}
console.log(
  `✓ vulnerability audit passed threshold ${requestedLevel} — ${advisories.length} lower-severity advisory(s) reported`,
);

function valueAfter(flag) {
  const direct = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (direct) return direct.slice(flag.length + 1);
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function severityOf(advisory) {
  const index = levels.indexOf(String(advisory.severity ?? '').toLowerCase());
  return index < 0 ? Number.POSITIVE_INFINITY : index;
}
