/**
 * Plain-language hints derived from runtime/test output. Failure lines
 * from assertion harnesses name the mismatch but not the mistake; small
 * models keep patching the wrong thing until a hint names it. Generalized
 * from the eval harness's perf-budget `wrapperReturnHint` (0/3 → 3/3 once
 * the wrapper misread was named).
 */

/**
 * Detect the "returned a wrapper object where an array was expected"
 * shape in assertion output lines (`… expected [...], got {...}`) and
 * name it. Returns null when no line matches — a bare array with wrong
 * contents is a genuinely different mistake and gets no hint.
 */
export function wrapperReturnHint(outputLines: readonly string[]): string | null {
  let wrapperKey: string | null = null;
  let hits = 0;
  for (const line of outputLines) {
    // Assertion printers emit `expected <e>, got <a>` with e/a as
    // JSON.stringify output, so `, got ` is an unambiguous delimiter.
    // Wrapper symptom: expected an array, got an object.
    const m = line.match(/expected (\[.*?), got (\{.*)$/);
    if (!m) continue;
    hits += 1;
    const got = m[2];
    if (wrapperKey === null && got) {
      const k = got.match(/^\{\s*"([^"]+)"/);
      if (k?.[1]) wrapperKey = k[1];
    }
  }
  if (hits === 0) return null;
  const example = wrapperKey ? `{ "${wrapperKey}": [...] }` : '{ ... }';
  return `Hint: the function is returning an OBJECT where the caller expects an ARRAY — it received a wrapper like \`${example}\`. Return the array itself (\`return result;\`), not an object with it nested inside.`;
}
