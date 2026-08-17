import { createManagedMarker } from '../fs/managed-marker.js';

export const OPENCODE_PLUGIN_MARKER = createManagedMarker({
  commentPrefix: '// ',
  noun: 'plugin',
});

/**
 * Render the plugin OpenCode auto-loads from its global config directory.
 *
 * The generated module reads the managed config at run time rather than
 * carrying a copy of the crew: the daemon already republishes that file when
 * the bridge address or the model roster moves, so there is exactly one source
 * of truth and no second staleness window.
 *
 * It holds no secret — only paths. OpenCode splices `{file:...}` into the raw
 * config text *before* parsing it, which a value injected by a plugin never
 * passes through, so the hook reads the credential file itself.
 *
 * Every failure is swallowed. This module loads in every OpenCode run the user
 * makes, including ones that have nothing to do with Gezel, so an uninstalled
 * daemon or a half-written file must leave OpenCode exactly as it was.
 */
export function buildOpenCodePluginSource(input: {
  configPath: string;
  tokenPath: string;
  providerId: string;
  ownerId: string;
}): string {
  const body = `import { readFile } from "node:fs/promises"

const CONFIG_PATH = ${JSON.stringify(input.configPath)}
const TOKEN_PATH = ${JSON.stringify(input.tokenPath)}
const PROVIDER_ID = ${JSON.stringify(input.providerId)}

export const GezelLocalModels = async () => ({
  config: async (config) => {
    try {
      const [rawConfig, rawToken] = await Promise.all([
        readFile(CONFIG_PATH, "utf8"),
        readFile(TOKEN_PATH, "utf8"),
      ])
      const managed = JSON.parse(rawConfig)?.provider?.[PROVIDER_ID]
      const apiKey = rawToken.trim()
      if (!managed?.models || !apiKey) return
      config.provider = {
        ...config.provider,
        [PROVIDER_ID]: {
          ...managed,
          options: { ...managed.options, apiKey },
          ...config.provider?.[PROVIDER_ID],
        },
      }
    } catch {
      // Gezel is not set up on this computer, or its files moved. Leaving the
      // config untouched is the only safe outcome.
    }
  },
})
`;
  return OPENCODE_PLUGIN_MARKER.build(body, input.ownerId);
}
