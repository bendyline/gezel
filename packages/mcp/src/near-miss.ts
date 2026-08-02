/**
 * Rank existing file names by closeness to a mistyped target path's
 * basename. Normalizing to lowercase alphanumerics catches the whole
 * punctuation-mangling class with an exact match — wild-caught on
 * gemma4-12b, where a sampler artifact turned `customers_a.csv` into
 * `customers_a,csv`, `customers_a\.csv`, `customers_a%2Ecsv`, … — and a
 * common-prefix fallback catches ordinary stem typos.
 */
export function closestFileNames(target: string, names: string[], limit = 3): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const t = norm(target);
  if (t.length === 0) return [];
  const scored = names
    .map((name) => {
      const n = norm(name);
      let score = 0;
      if (n === t) {
        score = 1000;
      } else {
        let i = 0;
        const cap = Math.min(n.length, t.length);
        while (i < cap && n[i] === t[i]) i++;
        score = i >= 3 ? i : 0;
      }
      return { name, score };
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((e) => e.name);
}
