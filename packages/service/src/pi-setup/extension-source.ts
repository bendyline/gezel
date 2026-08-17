import { createManagedMarker } from '../fs/managed-marker.js';

export const PI_EXTENSION_MARKER = createManagedMarker({
  commentPrefix: '// ',
  noun: 'extension',
});

/**
 * Render the extension pi loads — either explicitly with `pi -e <path>`, which
 * keeps everything inside GEZEL_HOME, or from a copy in pi's own
 * `extensions/` directory once the user asks for that.
 *
 * The module reads Gezel's managed roster at run time rather than carrying a
 * copy of the crew, so the model list and bridge address cannot drift from what
 * the daemon published, and the same bytes work in both delivery modes.
 *
 * It holds no secret — only paths. `models.json` supports a `!command` apiKey
 * form, but an extension can simply read the credential file itself.
 *
 * Every failure is swallowed. This module loads in every pi session the user
 * starts, including ones with nothing to do with Gezel, so a stopped daemon or
 * a half-written file must leave pi exactly as it was.
 */
export function buildPiExtensionSource(input: {
  rosterPath: string;
  tokenPath: string;
  ownerId: string;
}): string {
  const body = `import { readFileSync } from "node:fs"

const ROSTER_PATH = ${JSON.stringify(input.rosterPath)}
const TOKEN_PATH = ${JSON.stringify(input.tokenPath)}

export default function (pi) {
  try {
    const roster = JSON.parse(readFileSync(ROSTER_PATH, "utf8"))
    const provider = roster?.provider
    const apiKey = readFileSync(TOKEN_PATH, "utf8").trim()
    if (!provider?.id || !provider.baseUrl || !apiKey) return
    if (!Array.isArray(provider.models) || provider.models.length === 0) return
    pi.registerProvider(provider.id, {
      name: provider.name,
      baseUrl: provider.baseUrl,
      api: provider.api,
      apiKey,
      models: provider.models,
    })
  } catch {
    // Gezel is not set up on this computer, or its files moved. Leaving pi
    // untouched is the only safe outcome.
  }
}
`;
  return PI_EXTENSION_MARKER.build(body, input.ownerId);
}
