export interface HandboekGezkPaths {
  archive: string;
  lock: string;
  builder: string;
  serviceDir: string;
}

export interface HandboekGezkLock {
  inputs: string;
  content: string;
}

export function handboekGezkPaths(repoRoot?: string): HandboekGezkPaths;

export function gildeIdentity(repoRoot?: string, env?: NodeJS.ProcessEnv): string;

export function handboekInputsHash(repoRoot?: string, env?: NodeJS.ProcessEnv): string;

export function readHandboekLock(repoRoot?: string): HandboekGezkLock | null;

export function writeHandboekLock(lock: HandboekGezkLock, repoRoot?: string): void;

export function ensureHandboekGezk(opts?: {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  watch?: boolean;
  log?: (message: string) => void;
  runBuilder?: (paths: HandboekGezkPaths, env: NodeJS.ProcessEnv) => boolean;
}): 'skipped' | 'fresh' | 'stale' | 'refreshed';
