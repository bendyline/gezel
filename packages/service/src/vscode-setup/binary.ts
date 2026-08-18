import { runVersionProbe, which } from '../providers/codex-cli/binary.js';

export type VSCodeProduct = 'code' | 'code-insiders';

export interface VSCodeBinaryDetection {
  installed: boolean;
  product: VSCodeProduct;
  path?: string;
  version?: string;
  error?: string;
}

const NOT_FOUND =
  'VS Code was not found on PATH. Install it or add its command-line launcher to PATH, then re-check this card.';

export async function detectVSCodeBinary(opts: {
  override?: string;
  product?: VSCodeProduct;
  env?: NodeJS.ProcessEnv;
}): Promise<VSCodeBinaryDetection> {
  const env = opts.env ?? process.env;
  const overrideProduct = opts.product ?? productForPath(opts.override);
  const candidates: Array<{ path: string | null; product: VSCodeProduct }> = opts.override
    ? [{ path: opts.override, product: overrideProduct }]
    : [
        { path: which('code', env.PATH ?? '', env.PATHEXT), product: 'code' },
        {
          path: which('code-insiders', env.PATH ?? '', env.PATHEXT),
          product: 'code-insiders',
        },
      ];
  const candidate = candidates.find((entry) => entry.path);
  if (!candidate?.path) return { installed: false, product: overrideProduct, error: NOT_FOUND };
  try {
    return {
      installed: true,
      product: candidate.product,
      path: candidate.path,
      version: await runVersionProbe(candidate.path),
    };
  } catch (error) {
    return {
      installed: false,
      product: candidate.product,
      path: candidate.path,
      error: `VS Code at ${candidate.path} is not executable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function productForPath(path?: string): VSCodeProduct {
  return path?.toLowerCase().includes('insider') ? 'code-insiders' : 'code';
}
