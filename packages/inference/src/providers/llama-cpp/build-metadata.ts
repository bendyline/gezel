import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface LlamaCppBuildMetadata {
  schemaVersion: 1;
  engine: 'llama-cpp';
  revision: string;
  platform: string;
  backend: string;
  cudaArchitectures?: string[];
  cudaToolkit?: string;
}

/** Read build facts emitted beside gezel-llama-server; legacy bundles return null. */
export async function readLlamaCppBuildMetadata(
  binaryPath: string,
): Promise<LlamaCppBuildMetadata | null> {
  try {
    const parsed = JSON.parse(
      await readFile(join(dirname(binaryPath), 'gezel-llama-build.json'), 'utf8'),
    ) as Partial<LlamaCppBuildMetadata>;
    if (
      parsed.schemaVersion !== 1 ||
      parsed.engine !== 'llama-cpp' ||
      typeof parsed.revision !== 'string' ||
      typeof parsed.platform !== 'string' ||
      typeof parsed.backend !== 'string'
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      engine: 'llama-cpp',
      revision: parsed.revision,
      platform: parsed.platform,
      backend: parsed.backend,
      ...(Array.isArray(parsed.cudaArchitectures) &&
      parsed.cudaArchitectures.every((value) => typeof value === 'string')
        ? { cudaArchitectures: parsed.cudaArchitectures }
        : {}),
      ...(typeof parsed.cudaToolkit === 'string' ? { cudaToolkit: parsed.cudaToolkit } : {}),
    };
  } catch {
    return null;
  }
}

/** Last occurrence wins, matching llama-server's command-line parser. */
export function lastArgValue(args: string[], flag: string): string | undefined {
  let value: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === flag && index + 1 < args.length) value = args[index + 1];
  }
  return value;
}
