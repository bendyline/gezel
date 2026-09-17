const MAX_PATH_LABEL_CHARS = 64;

function pathList(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0,
    );
  } catch {
    return [];
  }
}

function compactPath(path: string): string {
  const clean = path.trim();
  if (clean.length <= MAX_PATH_LABEL_CHARS) return clean;

  const segments = clean.split('/').filter(Boolean);
  let suffix = segments.pop() ?? clean;
  while (segments.length > 0) {
    const candidate = `${segments.pop()}/${suffix}`;
    if (candidate.length + 2 > MAX_PATH_LABEL_CHARS) break;
    suffix = candidate;
  }
  if (suffix.length + 2 <= MAX_PATH_LABEL_CHARS) return `…/${suffix}`;
  return `…${suffix.slice(-(MAX_PATH_LABEL_CHARS - 1))}`;
}

/**
 * Give runtime-created fanout children a title that identifies their item.
 * Explicit variation titles are applied by the caller and take precedence.
 */
export function deriveFanoutChildTitle(context: Record<string, string>): string | undefined {
  // Keep the established invoice-run title contract.
  if (context.number && context.client) {
    return `Invoice ${context.number} — ${context.client}`;
  }
  if (context.client) return context.client;

  const paths = pathList(context.paths);
  if (context.batchNumber && paths.length > 0) {
    const start = Number(context.start);
    const end = Number(context.end);
    const hasRange =
      Number.isSafeInteger(start) && start > 0 && Number.isSafeInteger(end) && end >= start;
    const range = hasRange
      ? paths.length === 1
        ? `file ${start}`
        : `files ${start}–${end}`
      : `${paths.length} file${paths.length === 1 ? '' : 's'}`;
    const remainder = paths.length > 1 ? ` + ${paths.length - 1} more` : '';
    return `Review batch ${context.batchNumber} — ${range}: ${compactPath(paths[0]!)}${remainder}`;
  }

  return context.number || undefined;
}
