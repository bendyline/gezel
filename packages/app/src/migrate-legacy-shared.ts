/** Installer-time CLI for the pre-split machine-data compatibility exit. */
import { migrateLegacyMachineDataToShared } from './shared-migration.js';

function parseArgs(argv: readonly string[]): { source: string; dest: string } {
  let source = '';
  let dest = '';
  for (const arg of argv) {
    if (arg.startsWith('--source=')) source = arg.slice('--source='.length);
    else if (arg.startsWith('--dest=')) dest = arg.slice('--dest='.length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!source) throw new Error('--source=<absolute machine home> is required');
  if (!dest) throw new Error('--dest=<absolute shared home> is required');
  return { source, dest };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await migrateLegacyMachineDataToShared({
    sourceHome: args.source,
    sharedHome: args.dest,
  });
  process.stdout.write(
    `[migrate-legacy-shared] ready: projects=${result.moved.projects + result.recovered.projects} gezels=${result.moved.gezels + result.recovered.gezels} root=${result.sharedHome}\n`,
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[migrate-legacy-shared] FAILED: ${message}\n`);
  process.exit(1);
});
