import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNodeWithDependencyReadLease } from '../../../scripts/run-with-dependency-lease.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '../../..');
const mode = process.argv[2] ?? 'review';
const entries = {
  gallery: 'poppetje-gallery.tsx',
  groups: 'poppetje-groups.ts',
  eval: 'poppetje-eval.ts',
};
if (mode !== 'review' && !Object.hasOwn(entries, mode)) {
  throw new Error(`Unknown poppetje review mode: ${mode}`);
}
for (const step of mode === 'review' ? ['gallery', 'groups', 'eval'] : [mode]) {
  const code = await runNodeWithDependencyReadLease({
    repoRoot,
    args: mode === 'review' ? [] : process.argv.slice(3),
    entry: `packages/ui/scripts/${entries[step]}`,
    // The leased runner starts at the root, whose tsconfig has no JSX mode.
    env: { ...process.env, TSX_TSCONFIG_PATH: resolve(scriptsDir, '../tsconfig.json') },
  });
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}
