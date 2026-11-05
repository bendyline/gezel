import { parseAllDocuments } from 'yaml';

/**
 * YAML a config tool would load: every document parses, and the first one
 * is a mapping or a list. Prose is valid YAML (one long string), and so is a
 * file that is only comments, so "parses" alone would pass a stub.
 *
 * Kept out of `checks/`, which the SDK bundles into every script sandbox: the
 * YAML parser would ride along, and its Node build cannot load there.
 */
export function yamlValid(content: string): { ok: boolean; error?: string } {
  let docs: ReturnType<typeof parseAllDocuments>;
  try {
    docs = parseAllDocuments(content);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const list = Array.isArray(docs) ? docs : [docs];
  for (const doc of list) {
    const error = doc.errors[0];
    if (error) return { ok: false, error: error.message.split('\n')[0] };
  }
  const first = list.find((doc) => doc.contents !== null);
  const top = first?.toJS();
  if (top === null || typeof top !== 'object') {
    return { ok: false, error: 'the top level is not a mapping or a list' };
  }
  return { ok: true };
}
