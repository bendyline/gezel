import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function findBundledHandboekArchive(): string | null {
  const override = process.env.GEZEL_HANDBOEK_GEZK?.trim();
  if (override) return existsSync(override) ? resolve(override) : null;
  const here = dirname(fileURLToPath(import.meta.url));
  const built = join(here, 'handboek.gezk');
  if (existsSync(built)) return built;
  if (process.env.VITEST) return null;
  const source = join(here, '..', '..', 'assets', 'handboek', 'handboek.gezk');
  return existsSync(source) ? source : null;
}
