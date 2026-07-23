// Thin wrapper so the muscle-memory `pnpm build-index` keeps working:
// the canonical index generator lives in the gilde repo (tools/
// build-index.mjs) because gilde CI needs it without any gezel
// dependency. This just locates the sibling checkout and spawns it.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const override = process.env.GILDE_DIR?.trim();
const root = override ? resolve(override) : resolve(scriptsDir, '..', '..', '..', '..', 'gilde');

let name;
const pkgPath = join(root, 'package.json');
if (existsSync(pkgPath)) {
  try {
    name = JSON.parse(readFileSync(pkgPath, 'utf8')).name;
  } catch {
    name = undefined;
  }
}
if (name !== '@bendyline/gilde') {
  console.error(`[gilde] expected the bendyline/gilde checkout at ${root}`);
  console.error(
    '[gilde] clone https://github.com/bendyline/gilde.git as a sibling, or set GILDE_DIR.',
  );
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [join(root, 'tools', 'build-index.mjs'), ...process.argv.slice(2)],
  { stdio: 'inherit', cwd: root },
);
process.exit(result.status ?? 1);
