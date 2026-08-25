/**
 * Trim a catalog model name down to the part a person uses to talk about
 * it: "Qwen 3.8 (27B, Q4)" → "Qwen 3.8". The trailing parenthetical is
 * size/quantization detail — useful in a picker where models differ only
 * by it, noise in a status pill or a nav subline where the surrounding
 * text is already tight.
 */
export function shortModelName(name: string | undefined): string | undefined {
  if (!name) return name;
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim();
}
