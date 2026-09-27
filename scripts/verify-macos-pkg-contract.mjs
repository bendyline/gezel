import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_COMPONENT_ID = 'com.bendyline.gezel';
const EXPECTED_SCRIPT_FILE = './component-postinstall';
const EXPECTED_TIMEOUT_SECONDS = '1800';

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null;
}

export function validateMacPkgPackageInfo(packageInfoDocuments) {
  const postinstallTags = packageInfoDocuments.flatMap((document) =>
    Array.from(document.matchAll(/<postinstall\b[^>]*\/?\s*>/g), (match) => match[0]),
  );

  if (postinstallTags.length !== 1) {
    throw new Error(
      `expected exactly one macOS PKG postinstall entry, found ${postinstallTags.length}`,
    );
  }

  const tag = postinstallTags[0];
  const checks = [
    ['component-id', EXPECTED_COMPONENT_ID],
    ['file', EXPECTED_SCRIPT_FILE],
    ['timeout', EXPECTED_TIMEOUT_SECONDS],
  ];
  for (const [name, expected] of checks) {
    const actual = attribute(tag, name);
    if (actual !== expected) {
      throw new Error(
        `macOS PKG postinstall ${name} is ${JSON.stringify(actual)}; expected ${expected}`,
      );
    }
  }
}

async function findPackageInfoFiles(root) {
  const found = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name === 'PackageInfo') found.push(path);
    }
  }
  return found;
}

export async function verifyMacPkgContract(pkgPath) {
  if (process.platform !== 'darwin') {
    throw new Error('macOS PKG inspection requires macOS pkgutil');
  }

  const workDir = await mkdtemp(join(tmpdir(), 'gezel-pkg-contract-'));
  const expanded = join(workDir, 'expanded');
  try {
    execFileSync('/usr/sbin/pkgutil', ['--expand', resolve(pkgPath), expanded], {
      stdio: 'inherit',
    });
    const packageInfoPaths = await findPackageInfoFiles(expanded);
    if (packageInfoPaths.length === 0) {
      throw new Error('expanded macOS PKG contains no PackageInfo files');
    }
    const documents = await Promise.all(packageInfoPaths.map((path) => readFile(path, 'utf8')));
    validateMacPkgPackageInfo(documents);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const pkgPath = process.argv[2];
  if (!pkgPath) {
    console.error('Usage: node scripts/verify-macos-pkg-contract.mjs <installer.pkg>');
    process.exitCode = 2;
  } else {
    try {
      await verifyMacPkgContract(pkgPath);
      console.log(
        `verified macOS PKG component postinstall timeout (${EXPECTED_TIMEOUT_SECONDS}s)`,
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
