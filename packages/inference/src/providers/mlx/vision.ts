import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Installed checkpoint capability, not a catalog tag or GGUF projector. */
export async function hasMlxVisionTower(modelDir: string): Promise<boolean> {
  try {
    const config = JSON.parse(await readFile(join(modelDir, 'config.json'), 'utf8'));
    return Boolean(config.vision_config && typeof config.vision_config === 'object');
  } catch {
    return false;
  }
}
