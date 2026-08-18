import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { VSCodeSetupProfileOption } from '@bendyline/gezel';
import type { VSCodeProduct } from './binary.js';

export function vscodeUserDir(opts: {
  product: VSCodeProduct;
  override?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}): string {
  if (opts.override) return opts.override;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const folder = opts.product === 'code-insiders' ? 'Code - Insiders' : 'Code';
  if (platform === 'win32')
    return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), folder, 'User');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', folder, 'User');
  const configHome = env.XDG_CONFIG_HOME ?? join(home, '.config');
  return join(configHome, opts.product === 'code-insiders' ? 'Code - Insiders' : 'Code', 'User');
}

/** Discover the default profile plus every profile-specific user-data folder. */
export async function discoverVSCodeProfiles(opts: {
  product: VSCodeProduct;
  userDir: string;
}): Promise<VSCodeSetupProfileOption[]> {
  const profiles: VSCodeSetupProfileOption[] = [
    {
      id: `${opts.product}:default`,
      label: 'Default profile',
      product: opts.product,
      configPath: join(opts.userDir, 'chatLanguageModels.json'),
    },
  ];
  const profilesDir = join(opts.userDir, 'profiles');
  let entries: Dirent[];
  try {
    entries = await readdir(profilesDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return profiles;
    throw error;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    profiles.push({
      id: `${opts.product}:${entry.name}`,
      label: await profileLabel(join(profilesDir, entry.name), entry.name),
      product: opts.product,
      configPath: join(profilesDir, entry.name, 'chatLanguageModels.json'),
    });
  }
  return profiles;
}

async function profileLabel(profileDir: string, fallback: string): Promise<string> {
  try {
    const value = JSON.parse(await readFile(join(profileDir, 'profile.json'), 'utf8')) as {
      name?: unknown;
    };
    if (typeof value.name === 'string' && value.name.trim()) return value.name.trim();
  } catch {
    // VS Code does not promise per-directory metadata; the stable id is enough.
  }
  return `Profile ${fallback}`;
}
