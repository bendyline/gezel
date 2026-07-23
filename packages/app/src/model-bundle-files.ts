import { isAbsolute, resolve } from 'node:path';

/** Resolve `.gezmodel` file arguments from first/second-instance command lines. */
export function findGezmodelArguments(argv: readonly string[], workingDirectory: string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const raw of argv) {
    const value = raw.replace(/^"|"$/g, '');
    if (!value.toLowerCase().endsWith('.gezmodel')) continue;
    const full = isAbsolute(value) ? resolve(value) : resolve(workingDirectory, value);
    const key = process.platform === 'linux' ? full : full.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(full);
  }
  return paths;
}

export function portableGezmodelFilename(id: string): string {
  return `${id.replace(/[^a-z0-9._-]+/gi, '-').replace(/^[.-]+/, '') || 'model'}.gezmodel`;
}
