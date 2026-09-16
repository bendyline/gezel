/** Compact, service-written evidence of artifact text actually returned to a model. */
export interface ArtifactReadSlice {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function slice(value: Record<string, unknown>): ArtifactReadSlice | null {
  const { resolvedPath, startLine, endLine, totalLines } = value;
  if (
    typeof resolvedPath !== 'string' ||
    resolvedPath.length === 0 ||
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    !Number.isInteger(totalLines) ||
    (startLine as number) < 1 ||
    (endLine as number) < (startLine as number) ||
    (totalLines as number) < (endLine as number)
  ) {
    return null;
  }
  return {
    path: resolvedPath,
    startLine: startLine as number,
    endLine: endLine as number,
    totalLines: totalLines as number,
  };
}

/**
 * `read_file` and `read_files` count only when the MCP drawer adapter really
 * rerouted them to an artifact. Grep/search snippets do not count as full reads.
 */
export function artifactReadSlices(
  toolName: string,
  structuredContent: unknown,
): ArtifactReadSlice[] {
  const data = object(structuredContent);
  if (!data) return [];
  if (toolName === 'read_artifact') {
    const found = slice(data);
    return found ? [found] : [];
  }
  if (toolName === 'read_file') {
    if (data.resolvedSurface !== 'artifact') return [];
    const found = slice(data);
    return found ? [found] : [];
  }
  if (toolName !== 'read_artifacts' && toolName !== 'read_files') return [];
  if (!Array.isArray(data.results)) return [];
  return data.results.flatMap((entry) => {
    const result = object(entry);
    if (!result || result.status !== 'ok' || result.resolvedSurface !== 'artifact') return [];
    const found = slice(result);
    return found ? [found] : [];
  });
}
