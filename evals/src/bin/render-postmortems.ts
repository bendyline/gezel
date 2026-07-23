#!/usr/bin/env -S npx tsx
import { pathToFileURL } from 'node:url';
import { discoverTrialCandidates, writeTrialReport } from '../postmortem-report.ts';

interface CliArgs {
  root: string;
  force: boolean;
}

function parseCliArgs(argv: string[]): CliArgs | null {
  let root: string | undefined;
  let force = false;
  for (const arg of argv) {
    if (arg === '--force') {
      force = true;
    } else if (arg === '--help' || arg === '-h') {
      return null;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag: ${arg}`);
    } else if (root === undefined) {
      root = arg;
    } else {
      throw new Error(`unexpected positional argument: ${arg}`);
    }
  }
  if (!root) return null;
  return { root, force };
}

function printUsage(): void {
  process.stdout.write(
    'usage: render-postmortems.ts [--force] <matrix-or-runs-root>\n\n' +
      'Recursively finds terminal trial directories, writes score.json and a\n' +
      'deterministic postmortem.md, skips status.json trials, and preserves\n' +
      'existing reports unless --force is supplied.\n',
  );
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args) {
    printUsage();
    return;
  }

  const candidates = await discoverTrialCandidates(args.root);
  const counts = new Map<string, number>();
  let errors = 0;
  for (const trialDir of candidates) {
    try {
      const result = await writeTrialReport(trialDir, { force: args.force });
      counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
      process.stdout.write(`[postmortem] ${result.status} ${trialDir}\n`);
    } catch (error) {
      errors++;
      process.stderr.write(`[postmortem] error ${trialDir}: ${String(error)}\n`);
    }
  }

  process.stdout.write(
    `[postmortem] done candidates=${candidates.length} written=${counts.get('written') ?? 0} active=${counts.get('skipped-active') ?? 0} existing=${counts.get('skipped-existing') ?? 0} incomplete=${counts.get('skipped-incomplete') ?? 0} errors=${errors}\n`,
  );
  if (errors > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[postmortem] fatal: ${String(error)}\n`);
    process.exitCode = 2;
  });
}
