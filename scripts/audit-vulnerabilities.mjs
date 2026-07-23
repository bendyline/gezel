#!/usr/bin/env node
/** Audit exact production versions through npm's current bulk advisory API. */

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
const response = await fetch('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', {
  method: 'POST',
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'gezel-production-audit/1',
  },
  body: JSON.stringify(packages),
  redirect: 'error',
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) {
  await response.body?.cancel();
  throw new Error(`npm bulk advisory endpoint returned HTTP ${response.status}`);
}
const advisories = await readAdvisories(response);
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

async function readAdvisories(response) {
  const maxBytes = 10 * 1024 * 1024;
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error('npm bulk advisory response exceeded 10 MiB');
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes)
    throw new Error('npm bulk advisory response exceeded 10 MiB');
  const body = JSON.parse(text);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('npm bulk advisory endpoint returned an invalid response');
  }
  const unique = new Map();
  for (const [packageName, entries] of Object.entries(body)) {
    if (!Array.isArray(entries)) throw new Error('npm returned an invalid advisory group');
    for (const advisory of entries) {
      if (!advisory || typeof advisory !== 'object')
        throw new Error('npm returned an invalid advisory');
      const normalized = { ...advisory, name: advisory.name ?? packageName };
      const key = `${normalized.id ?? ''}\0${normalized.name}\0${normalized.url ?? ''}`;
      unique.set(key, normalized);
    }
  }
  return [...unique.values()].sort(
    (a, b) => severityOf(b) - severityOf(a) || String(a.name).localeCompare(String(b.name)),
  );
}
