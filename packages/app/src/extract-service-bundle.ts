/**
 * extract-service-bundle — install-time CLI invoked by per-platform installers
 * (NSIS on Windows, PKG postinstall on macOS, deb/rpm afterInstall on Linux)
 * to extract the shipped service bundle into the system-scope service home.
 *
 * Windows invokes this through the separately bundled Node runtime. macOS and
 * Linux currently use `ELECTRON_RUN_AS_NODE=1 <Electron exe>`. Both paths avoid
 * requiring a system Node during install.
 *
 * Exit codes:
 *   0 — extraction succeeded (fresh-install, upgraded, forced, or up-to-date)
 *   1 — argument parsing or extraction error
 *
 * Designed to be self-contained: bundled by tsup into a single file with
 * `tar` inlined, so the installer doesn't need a node_modules tree at all.
 */
import { extractBundleIfNeeded } from './supervisor/extract-bundle.js';

interface CliArgs {
  tarball: string;
  meta: string;
  dest: string;
  force: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: Partial<CliArgs> = { force: false };
  for (const a of argv) {
    if (a === '--force') {
      args.force = true;
    } else if (a.startsWith('--tarball=')) {
      args.tarball = a.slice('--tarball='.length);
    } else if (a.startsWith('--meta=')) {
      args.meta = a.slice('--meta='.length);
    } else if (a.startsWith('--dest=')) {
      args.dest = a.slice('--dest='.length);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!args.tarball) throw new Error('--tarball=<path> is required');
  if (!args.meta) throw new Error('--meta=<path> is required');
  if (!args.dest) throw new Error('--dest=<path> is required');
  return args as CliArgs;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const logger = {
    info: (m: string) => process.stdout.write(`${m}\n`),
    warn: (m: string) => process.stderr.write(`${m}\n`),
  };
  const result = await extractBundleIfNeeded({
    tarballPath: args.tarball,
    metaPath: args.meta,
    installDir: args.dest,
    force: args.force,
    logger,
  });
  // The elapsed time lands in the package manager's own transcript (apt's
  // "Setting up gezel", /var/log/install.log, the NSIS log), which is the only
  // record that exists when someone reports a slow install.
  process.stdout.write(
    `[extract-service-bundle] ${result.action}: shipped=${result.shippedVersion} ` +
      `installed=${result.installedVersion} elapsed=${result.elapsedMs}ms` +
      `${result.filesExtracted === null ? '' : ` files=${result.filesExtracted}`}\n`,
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[extract-service-bundle] FAILED: ${msg}\n`);
  process.exit(1);
});
