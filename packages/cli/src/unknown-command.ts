/**
 * The root `gezel` command takes no operands (bare `gezel` opens the
 * terminal app), so commander reported a mistyped subcommand as "too many
 * arguments. Expected 0 arguments but got 1" and never offered the command
 * the person meant. This builds the message commander gives a command
 * without a default action, plus a pointer to `run` when the operand reads
 * like a prompt rather than a command.
 */

export function unknownCommandMessage(
  operands: readonly string[],
  known: readonly string[],
): string {
  const word = operands[0] ?? '';
  const lines = [`error: unknown command '${word}'`];
  const looksLikePrompt = operands.length > 1 || /\s/.test(word) || word.length > 24;
  const suggestion = looksLikePrompt ? undefined : closestCommand(word, known);
  if (suggestion) lines.push(`(Did you mean ${suggestion}?)`);
  if (looksLikePrompt) {
    lines.push('To send a prompt, use: gezel run "<prompt>"');
  }
  lines.push('Run `gezel --help` to see every command.');
  return lines.join('\n');
}

export function closestCommand(word: string, known: readonly string[]): string | undefined {
  const target = word.toLowerCase();
  if (!target) return undefined;
  const limit = Math.max(1, Math.floor(target.length * 0.4));
  let best: { name: string; distance: number } | undefined;
  for (const name of known) {
    const distance = editDistance(target, name.toLowerCase());
    if (distance > limit) continue;
    if (!best || distance < best.distance) best = { name, distance };
  }
  return best?.name;
}

/** Optimal-string-alignment distance: Levenshtein plus adjacent transposition. */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = value;
    }
  }
  return d[a.length]![b.length]!;
}
