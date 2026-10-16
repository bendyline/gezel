import type { GezelClient } from '@bendyline/gezel-client/node';
import { CliError } from './connection.js';
import { resolveGezelArg } from './tui/gezel-picker.js';

/**
 * Resolve `gezel run --gezel <ref>` to a gezel id.
 *
 * WHY: the flag is documented as "gezel id or name", but the value went to
 * the daemon as an id unchanged, so `--gezel "Ship Tester"` answered HTTP 500
 * (2026-10-15 npm ship audit). Matching follows the TUI's `/gezel` command:
 * id, name, role-based name or role, exact before prefix. A run must never
 * guess between two gezels, so an exact name two of them share (random names
 * can repeat) is reported with ids, as is an ambiguous prefix.
 */
export async function resolveRunGezel(
  client: Pick<GezelClient, 'listGezels'>,
  ref: string,
): Promise<string> {
  const { gezels } = await client.listGezels();
  // Ids are slugs of names, so only an exact-case id counts as one: "Yujin"
  // must reach the shared-name check below rather than match id `yujin`.
  const byId = gezels.find((gezel) => gezel.id === ref.trim());
  if (byId) return byId.id;

  const query = ref.trim().toLowerCase();
  const sameName = gezels.filter((gezel) => gezel.name.trim().toLowerCase() === query);
  if (sameName.length > 1) throw ambiguous(ref, sameName);

  const match = resolveGezelArg(ref, { gezels, templates: [] });
  if (match.kind === 'gezel') return match.gezelId;
  if (match.kind === 'ambiguous') {
    const candidates = gezels.filter((gezel) => match.labels.includes(gezel.name));
    throw ambiguous(ref, candidates);
  }
  throw new CliError(`No gezel matches "${ref}". Run \`gezel agent list\` to see your gezels.`);
}

function ambiguous(ref: string, candidates: ReadonlyArray<{ id: string; name: string }>): CliError {
  const listed = candidates.map((gezel) => `${gezel.name} (${gezel.id})`).join(', ');
  return new CliError(`"${ref}" matches more than one gezel: ${listed}. Pass the id instead.`);
}
