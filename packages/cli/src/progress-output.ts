/**
 * Progress text that redraws in place on a terminal and stays short in a log.
 *
 * WHY: the download and export commands report with `\r`-prefixed updates,
 * one per percent or per chunk. A terminal redraws one line; a pipe, a CI log
 * or a captured `2>` keeps every update: `gezel native install` wrote 78 KB of
 * progress for one engine (2026-10-15 npm audit). Off a terminal this prints
 * an update at most every `intervalMs`, every finished line (text ending in a
 * newline), and nothing twice.
 */
export function progressWriter(
  stream: { isTTY?: boolean; write(text: string): unknown },
  options: { intervalMs?: number; now?: () => number } = {},
): (text: string) => void {
  if (stream.isTTY) {
    return (text) => {
      stream.write(text);
    };
  }
  const intervalMs = options.intervalMs ?? 15_000;
  const now = options.now ?? Date.now;
  let lastLine = '';
  let lastAt = Number.NEGATIVE_INFINITY;
  return (text) => {
    const finished = text.endsWith('\n');
    const line = text.replace(/\r/g, '').trim();
    if (!line || line === lastLine) return;
    if (!finished && now() - lastAt < intervalMs) return;
    stream.write(`${line}\n`);
    lastLine = line;
    lastAt = now();
  };
}

/** {@link progressWriter} for the CLI's own stderr. */
export function stderrProgress(): (text: string) => void {
  return progressWriter(process.stderr);
}
