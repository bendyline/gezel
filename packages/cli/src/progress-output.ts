/**
 * Progress text that redraws in place on a terminal and stays short in a log.
 *
 * WHY: the download and export commands report with `\r`-prefixed updates,
 * one per percent or per chunk. A terminal redraws one line; a pipe, a CI log
 * or a captured `2>` keeps every update: `gezel native install` wrote 78 KB of
 * progress for one engine (2026-10-15 npm audit), and `gezel --download run`
 * wrote hundreds of them onto one line of a redirected stderr (2026-11-11).
 *
 * Off a terminal this prints every finished line (text ending in a newline),
 * nothing twice, and of the updates in between: for a percentage, its first
 * update (which names the size) and one each at 25, 50 and 75%; for anything
 * else, at most one every `intervalMs`.
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
  const intervalMs = options.intervalMs ?? 60_000;
  const now = options.now ?? Date.now;
  let lastLine = '';
  let lastAt = Number.NEGATIVE_INFINITY;
  let series: { label: string; quarter: number } | undefined;
  return (text) => {
    const finished = text.endsWith('\n');
    const line = text.replace(/\r/g, '').trim();
    if (!line || line === lastLine) return;
    if (finished) {
      series = undefined;
    } else {
      const percent = /(\d{1,3})%/.exec(line);
      if (percent) {
        // The text before the figure, digits aside, names one download: a
        // model id with digits in it, or a "3/40 (" count, stays one series.
        const label = line.slice(0, percent.index).replace(/\d+/g, '#').trim();
        const quarter = Math.floor(Number(percent[1]) / 25);
        if (series?.label === label && (quarter <= series.quarter || quarter > 3)) return;
        series = { label, quarter };
      } else if (now() - lastAt < intervalMs) {
        return;
      }
    }
    stream.write(`${line}\n`);
    lastLine = line;
    lastAt = now();
  };
}

/** {@link progressWriter} for the CLI's own stderr. */
export function stderrProgress(): (text: string) => void {
  return progressWriter(process.stderr);
}
