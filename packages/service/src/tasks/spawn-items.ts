/**
 * Parse a spawn-host's `overFile` JSON into the item array that drives a
 * declarative fanout. `itemsPath` (dotted) navigates to a nested array;
 * absent → the parsed value must itself be the array. Returns [] on any
 * parse/shape problem so a malformed run degrades to "no fanout", never a
 * throw. Only plain-object items are kept (each becomes a child's context).
 */
export function extractSpawnItems(raw: string, itemsPath?: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  let node: unknown = parsed;
  if (itemsPath) {
    for (const key of itemsPath.split('.')) {
      if (node && typeof node === 'object' && key in (node as Record<string, unknown>)) {
        node = (node as Record<string, unknown>)[key];
      } else {
        return [];
      }
    }
  }
  if (!Array.isArray(node)) return [];
  return node.filter(
    (it): it is Record<string, unknown> => !!it && typeof it === 'object' && !Array.isArray(it),
  );
}
