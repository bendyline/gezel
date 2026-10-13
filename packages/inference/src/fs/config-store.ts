import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type GezelConfig, GezelConfigSchema, KeyedLock } from '@bendyline/gezel';
import { gezelPaths } from '@bendyline/gezel/paths';
import { writeFileAtomic } from './atomic.js';

export class ConfigCorruptionError extends Error {
  readonly code = 'CONFIG_CORRUPT';
  constructor(message: string) {
    super(message);
    this.name = 'ConfigCorruptionError';
  }
}

// All configuration writers in one owning daemon share this queue.
const configWriteLocks = new KeyedLock();

/** Configuration persistence only: safe to construct in an engine-only home. */
export class ConfigStore {
  constructor(private readonly home: string) {}
  get homePath(): string {
    return this.home;
  }

  async readConfig(): Promise<GezelConfig> {
    const p = gezelPaths(this.home);
    let raw: string;
    try {
      raw = await readFile(p.config, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new ConfigCorruptionError(
        `Unable to read ${p.config}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ConfigCorruptionError(
        `config.json is not valid JSON. Gezel left it untouched: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const result = GezelConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new ConfigCorruptionError(
        `config.json failed schema validation. Gezel left it untouched: ${result.error.message}`,
      );
    }
    return result.data;
  }

  async writeConfig(config: Partial<Record<keyof GezelConfig, unknown>>): Promise<GezelConfig> {
    return configWriteLocks.run(resolve(gezelPaths(this.home).config), () =>
      this.writeConfigPatch(config),
    );
  }

  private async writeConfigPatch(
    config: Partial<Record<keyof GezelConfig, unknown>>,
  ): Promise<GezelConfig> {
    const p = gezelPaths(this.home);
    const existing = await this.readConfig();
    // Explicit `null` on any patched field means "reset to default" —
    // drop it from the merged shape instead of persisting the null.
    // The transport strips `undefined`, so the UI uses null to clear a field.
    // Internal undefined patches retain their omission-on-JSON behavior.
    const merged: Record<string, unknown> = { ...existing, ...config };
    for (const [k, v] of Object.entries(config)) {
      if (v === null) delete merged[k];
    }
    // externalFolders is a nested object; per-scope `null` clears that
    // scope's external path. If all three scopes end up absent the
    // parent object goes away entirely so the on-disk config stays
    // narrow.
    if ('externalFolders' in config && config.externalFolders !== null) {
      const incoming = config.externalFolders;
      if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
        const existingExternal = existing.externalFolders ?? {};
        const mergedExternal: Record<string, unknown> = { ...existingExternal, ...incoming };
        for (const [k, v] of Object.entries(incoming)) {
          if (v === null) delete mergedExternal[k];
        }
        if (Object.keys(mergedExternal).length === 0) {
          delete merged.externalFolders;
        } else {
          merged.externalFolders = mergedExternal;
        }
      }
    }
    // ambientDashboard combines user-authored preferences with the Electron
    // shell's last-known primary-display target. A settings toggle commonly
    // patches only `{ enabled }`; merge this object so that action cannot erase
    // the screen geometry needed by scheduled renders after the app closes.
    if ('ambientDashboard' in config && config.ambientDashboard !== null) {
      const incoming = config.ambientDashboard;
      if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
        merged.ambientDashboard = {
          ...(existing.ambientDashboard ?? {}),
          ...incoming,
        };
      }
    }
    const validated = GezelConfigSchema.parse(merged);
    await writeFileAtomic(p.config, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
    return validated;
  }
}
