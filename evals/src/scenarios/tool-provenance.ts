export interface ProvenanceToolCall {
  name: string;
  success: boolean;
  path?: string;
  argsFull?: string;
  argsSummary?: string;
}

const STRUCTURED_MUTATION_TOOLS = new Set([
  'write_file',
  'append_to_file',
  'replace_in_file',
  'replace_lines',
  'apply_patch',
  'insert_at_marker',
]);

export function provenanceToolArgumentText(call: ProvenanceToolCall): string {
  return [call.argsFull, call.argsSummary].filter(Boolean).join('\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pathLiteral(path: string): string {
  const escaped = escapeRegExp(path);
  return `(?:["'](?:\\./)?${escaped}["']|(?:\\./)?${escaped})`;
}

function firstMatchIndex(text: string, patterns: RegExp[]): number {
  let first = -1;
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.index !== undefined && (first < 0 || match.index < first)) first = match.index;
  }
  return first;
}

function shellReadIndex(call: ProvenanceToolCall, path: string): number {
  if (call.name !== 'shell' || call.success !== true) return -1;
  const text = provenanceToolArgumentText(call);
  const target = pathLiteral(path);
  return firstMatchIndex(text, [
    new RegExp(`\\b(?:cat|head|tail)(?:\\s+-[^\\s]+)*\\s+${target}(?=$|["'\\s;&|)])`, 'i'),
    new RegExp(`\\bsed\\b[\\s\\S]{0,100}?\\s${target}(?=$|["'\\s;&|)])`, 'i'),
    new RegExp(`\\bopen\\(\\s*${target}(?:\\s*,\\s*["']r[bt]?["'])?`, 'i'),
    new RegExp(`\\bPath\\(\\s*${target}\\s*\\)\\s*\\.\\s*read_(?:text|bytes)\\s*\\(`, 'i'),
    new RegExp(`\\b(?:readFileSync|readFile)\\(\\s*${target}(?:\\s*,|\\s*\\))`, 'i'),
  ]);
}

function shellMutationIndex(call: ProvenanceToolCall, path: string): number {
  if (call.name !== 'shell' || call.success !== true) return -1;
  const text = provenanceToolArgumentText(call);
  const target = pathLiteral(path);
  return firstMatchIndex(text, [
    new RegExp(`(?:>>|>)\\s*${target}(?=$|["'\\s;&|])`, 'i'),
    new RegExp(`\\btee(?:\\s+-a)?\\s+${target}(?=$|["'\\s;&|])`, 'i'),
    new RegExp(
      `\\b([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*Path\\(\\s*${target}\\s*\\)[\\s\\S]{0,4000}?\\b\\1\\.write_(?:text|bytes)\\s*\\(`,
      'i',
    ),
    new RegExp(`\\bPath\\(\\s*${target}\\s*\\)\\s*\\.\\s*write_(?:text|bytes)\\s*\\(`, 'i'),
    new RegExp(`\\bopen\\(\\s*${target}\\s*,\\s*["'](?:w|a|x)[bt]?["']`, 'i'),
    new RegExp(
      `\\b(?:writeFileSync|appendFileSync|writeFile|appendFile)\\(\\s*${target}(?:\\s*,|\\s*\\))`,
      'i',
    ),
  ]);
}

function shellOverwriteIndex(call: ProvenanceToolCall, path: string): number {
  if (call.name !== 'shell' || call.success !== true) return -1;
  const text = provenanceToolArgumentText(call);
  const target = pathLiteral(path);
  return firstMatchIndex(text, [
    new RegExp(`(?<!>)>\\s*${target}(?=$|["'\\s;&|])`, 'i'),
    new RegExp(`\\btee\\s+${target}(?=$|["'\\s;&|])`, 'i'),
    new RegExp(
      `\\b([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*Path\\(\\s*${target}\\s*\\)[\\s\\S]{0,4000}?\\b\\1\\.write_(?:text|bytes)\\s*\\(`,
      'i',
    ),
    new RegExp(`\\bPath\\(\\s*${target}\\s*\\)\\s*\\.\\s*write_(?:text|bytes)\\s*\\(`, 'i'),
    new RegExp(`\\bopen\\(\\s*${target}\\s*,\\s*["'](?:w|x)[bt]?["']`, 'i'),
    new RegExp(`\\bwriteFile(?:Sync)?\\(\\s*${target}(?:\\s*,|\\s*\\))`, 'i'),
  ]);
}

export function provenanceToolReadsPath(call: ProvenanceToolCall, path: string): boolean {
  if (call.success !== true) return false;
  if (call.name === 'read_file') return call.path === path;
  return shellReadIndex(call, path) >= 0;
}

export function provenanceToolMutatesPath(call: ProvenanceToolCall, path: string): boolean {
  if (call.success !== true) return false;
  if (STRUCTURED_MUTATION_TOOLS.has(call.name)) return call.path === path;
  return shellMutationIndex(call, path) >= 0;
}

export function provenanceShellOverwritesPath(call: ProvenanceToolCall, path: string): boolean {
  return shellOverwriteIndex(call, path) >= 0;
}

/**
 * A CLI-native shell call can read its inputs and write the deliverable in
 * one command. Preserve that within-call ordering instead of collapsing the
 * whole call to one timestamp and falsely treating the reads as too late.
 */
export function provenanceShellReadPrecedesMutation(
  call: ProvenanceToolCall,
  readPath: string,
  mutationPath: string,
): boolean {
  const readIndex = shellReadIndex(call, readPath);
  const mutationIndex = shellMutationIndex(call, mutationPath);
  return readIndex >= 0 && mutationIndex >= 0 && readIndex < mutationIndex;
}
