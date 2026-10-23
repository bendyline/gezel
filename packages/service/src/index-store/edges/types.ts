import type { FileEdge, ImportBinding } from '../index-store-types.js';
import type { RequireJsConfig } from './requirejs.js';

/** One indexed file, as resolution sees it. */
export interface EdgeFile {
  path: string;
  lang: string | null;
  kind: string | null;
}

/** One raw import row (an importer and the specifier it wrote). */
export interface RawImport {
  srcPath: string;
  raw: string;
  bindings: ImportBinding[] | null;
  flags: number;
}

/**
 * The project's build manifests, read once per resolution. Keyed by
 * project-relative path; a file that failed to read or parse is absent.
 */
export interface ProjectConfigFiles {
  /** tsconfig*.json and jsconfig.json, parsed (JSONC). */
  tsconfigs: Map<string, unknown>;
  /** package.json, parsed. */
  packageJsons: Map<string, unknown>;
  /** go.mod text. */
  goMods: Map<string, string>;
  /** Cargo.toml text. */
  cargoTomls: Map<string, string>;
  /** RequireJS setups, one per page that loads the loader. */
  requireJs?: RequireJsConfig[];
}

/** Where one specifier resolved: one or more files, and the resolver that found them. */
export interface Resolution {
  dsts: string[];
  resolver: string;
}

/** Per-language counts, so a view can say which languages it can draw arrows for. */
export interface EdgeCoverage {
  files: number;
  filesWithImports: number;
  filesWithEdges: number;
  edges: number;
}

export interface ResolvedGraph {
  edges: FileEdge[];
  coverage: Record<string, EdgeCoverage>;
}
