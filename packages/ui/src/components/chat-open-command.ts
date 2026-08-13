export type OpenChatReferenceKind = 'artifact' | 'document' | 'workspace';

/** A file recently surfaced by the chat References rail. */
export interface OpenChatReference {
  key: string;
  kind: OpenChatReferenceKind;
  path: string;
  projectId?: string;
}

export type OpenChatTarget =
  | { type: 'folder'; folder: 'artifacts' | 'workspace' }
  | { type: 'reference'; reference: OpenChatReference };

export interface OpenChatSuggestion {
  key: string;
  label: string;
  description: string;
  target: OpenChatTarget;
}

/**
 * Return the text after `/open`, or `null` when the draft is ordinary chat.
 * Commands are deliberately single-line so a pasted prompt beginning with
 * `/open` cannot unexpectedly become a local action.
 */
export function parseOpenChatQuery(source: string): string | null {
  if (source.includes('\n') || source.includes('\r')) return null;
  const match = source.trim().match(/^\/open(?:[ \t]+(.*))?$/i);
  return match ? (match[1] ?? '').trim() : null;
}

/** Build the visible folder keywords plus the most-recent matching files. */
export function openChatSuggestions(
  query: string,
  recentReferences: readonly OpenChatReference[],
  maxFiles = 8,
): OpenChatSuggestion[] {
  const needle = normalizeLookup(query);
  const folders: OpenChatSuggestion[] = (['workspace', 'artifacts'] as const).map((folder) => ({
    key: `folder:${folder}`,
    label: folder,
    description: `Open the project ${folder} folder`,
    target: { type: 'folder', folder },
  }));
  const matchingFolders = folders.filter((item) => matches(needle, item.label));

  const seen = new Set<string>();
  const files: OpenChatSuggestion[] = [];
  for (const reference of recentReferences) {
    const lookupKey = `${reference.projectId ?? ''}:${reference.kind}:${normalizeLookup(reference.path)}`;
    if (seen.has(lookupKey)) continue;
    seen.add(lookupKey);
    if (!matches(needle, reference.path) && !matches(needle, basename(reference.path))) continue;
    files.push({
      key: `reference:${reference.key}`,
      label: reference.path,
      description: `Open recent ${reference.kind}`,
      target: { type: 'reference', reference },
    });
    if (files.length >= maxFiles) break;
  }

  return [...matchingFolders, ...files];
}

/** Resolve an entered target exactly; partial matches remain suggestions only. */
export function resolveOpenChatTarget(
  query: string,
  recentReferences: readonly OpenChatReference[],
): OpenChatTarget | null {
  const needle = normalizeLookup(query);
  if (needle === 'workspace' || needle === 'artifacts') {
    return { type: 'folder', folder: needle };
  }
  if (!needle) return null;

  const exactPath = recentReferences.find(
    (reference) => normalizeLookup(reference.path) === needle,
  );
  if (exactPath) return { type: 'reference', reference: exactPath };

  // A basename is convenient when it identifies one and only one MRU entry.
  const basenameMatches = recentReferences.filter(
    (reference) => normalizeLookup(basename(reference.path)) === needle,
  );
  return basenameMatches.length === 1
    ? { type: 'reference', reference: basenameMatches[0]! }
    : null;
}

function normalizeLookup(value: string): string {
  return value.trim().replaceAll('\\', '/').toLowerCase();
}

function matches(needle: string, candidate: string): boolean {
  return !needle || normalizeLookup(candidate).includes(needle);
}

function basename(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}
