import { z } from 'zod';

export const FILE_GLOB_MAX_LENGTH = 512;
export const FILE_GLOB_MAX_DEPTH = 8;
export const FILE_GLOB_MAX_EXPANSIONS = 128;

interface GlobGroup {
  open: string;
  start: number;
  commas: number;
  range: boolean;
}

/**
 * Check untrusted globs without invoking a glob parser. In particular, braces
 * recursively walks its AST and materializes Cartesian products before any
 * filesystem work or result limit applies. Count a conservative upper bound:
 * multiplying every group's choices also bounds nested alternatives.
 */
function globComplexityError(pattern: string): string | undefined {
  // Zod continues running refinements after a length check fails.
  if (pattern.length > FILE_GLOB_MAX_LENGTH) return;
  const groups: GlobGroup[] = [];
  let expansions = 1;
  let quote: string | undefined;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    // braces ignores NBSP and BOM, which can otherwise hide range syntax.
    const code = pattern.charCodeAt(i);
    if (code < 32 || code === 127 || code === 160 || code === 0xfeff) {
      return 'glob must not contain control characters, NBSP, or BOM';
    }
    if (char === '\\') {
      // Do not interpret escaped delimiters as groups.
      if (++i === pattern.length) return 'glob must not end with an incomplete escape';
      const escapedCode = pattern.charCodeAt(i);
      if (
        escapedCode < 32 ||
        escapedCode === 127 ||
        escapedCode === 160 ||
        escapedCode === 0xfeff
      ) {
        return 'glob must not contain control characters, NBSP, or BOM';
      }
      continue;
    }
    const group = groups.at(-1);
    // Braces treats character classes as opaque, including nested classes.
    if (group?.open === '[' && char !== '[' && char !== ']') continue;
    // Quoted delimiters are literal AST text. Counting them as groups could
    // let quoted closing braces disguise the real parser nesting depth.
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{' || char === '(' || char === '[') {
      groups.push({ open: char, start: i, commas: 0, range: false });
      if (groups.length > FILE_GLOB_MAX_DEPTH) {
        return `glob nesting must not exceed ${FILE_GLOB_MAX_DEPTH} levels; simplify the pattern`;
      }
    } else if (char === '}' || char === ')' || char === ']') {
      const open = char === '}' ? '{' : char === ')' ? '(' : '[';
      if (group?.open !== open)
        return 'glob groups must have balanced braces, parentheses, and brackets';
      groups.pop();
      if (open !== '{') continue;
      let choices = group.commas + 1;
      if (group.range && group.commas === 0) {
        const range = /^(-?\d+|[a-zA-Z])\.\.(-?\d+|[a-zA-Z])(?:\.\.(-?\d+))?$/.exec(
          pattern.slice(group.start + 1, i),
        );
        if (!range) return 'glob ranges must use simple numeric or alphabetic endpoints';
        const startText = range[1]!;
        const endText = range[2]!;
        const numeric = /^-?\d+$/.test(startText) && /^-?\d+$/.test(endText);
        const alphabetic = /^[a-zA-Z]$/.test(startText) && /^[a-zA-Z]$/.test(endText);
        if (!numeric && !alphabetic) return 'glob range endpoints must have the same type';
        const start = numeric ? Number(startText) : startText.charCodeAt(0);
        const end = numeric ? Number(endText) : endText.charCodeAt(0);
        const step = range[3] === undefined ? 1 : Number(range[3]);
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          !Number.isSafeInteger(step) ||
          step === 0
        ) {
          return 'glob range endpoints and steps must be safe integers with a nonzero step';
        }
        // Ignore the step when estimating: it can only reduce the expansion.
        choices = Math.abs(end - start) + 1;
      }
      expansions *= choices;
      if (expansions > FILE_GLOB_MAX_EXPANSIONS) {
        return `glob brace expansion must not exceed ${FILE_GLOB_MAX_EXPANSIONS} combinations; split the search`;
      }
    } else if (group?.open === '{') {
      if (char === ',') group.commas++;
      if (char === '.' && pattern[i + 1] === '.') group.range = true;
    }
  }
  if (quote) return 'glob quotes must be balanced; escape literal quote characters';
  if (groups.length) return 'glob groups must have balanced braces, parentheses, and brackets';
}

export const FileGlobSchema = z
  .string()
  .min(1)
  .max(FILE_GLOB_MAX_LENGTH)
  .superRefine((pattern, ctx) => {
    const error = globComplexityError(pattern);
    if (error) ctx.addIssue({ code: 'custom', message: error });
  })
  .describe(
    `File glob, at most ${FILE_GLOB_MAX_LENGTH} characters, ${FILE_GLOB_MAX_DEPTH} nesting levels, and ${FILE_GLOB_MAX_EXPANSIONS} brace combinations. Use simpler patterns or split large searches.`,
  );
export type FileGlob = z.infer<typeof FileGlobSchema>;
