import snapshot from '../knowledge-catalog.json';

/** One installable catalog version, pinned the way the daemon's installer trusts it. */
export interface MobileKnowledgeCatalog {
  readonly id: string;
  readonly publisherId: string;
  readonly name: string;
  readonly description: string;
  readonly language: string;
  readonly license: string;
  readonly licenseUrl?: string;
  readonly category?: string;
  readonly version: string;
  readonly huggingface: { readonly repo: string; readonly revision: string; readonly path: string };
  readonly sha256: string;
  readonly archiveBytes: number;
  readonly documents: number;
  readonly chunks: number;
  readonly embeddingProfile: { readonly id: string; readonly modelRepo: string };
}

/** A profile's query model: the files its catalogs' searches embed questions with. */
export interface MobileQueryModel {
  readonly id: string;
  readonly queryInstruction: string;
  readonly pooling: string;
  readonly normalized: boolean;
  readonly dimensions: number;
  readonly maxTokens: number;
  /** The ONNX graph and tokenizer among `files`. */
  readonly model: string;
  readonly tokenizer: string;
  readonly files: readonly { name: string; url: string; sha256: string; size: number }[];
}

/** The Gilde knowledge catalogs this SDK release can install (scripts/refresh-knowledge-catalog.ts). */
export const mobileKnowledgeCatalogs: readonly MobileKnowledgeCatalog[] = snapshot.catalogs;
export const mobileKnowledgeCatalogVersion = snapshot.version;
export const mobileQueryModels: readonly MobileQueryModel[] = snapshot.queryModels;

/** Where a profile's query model lives in the store (`multilingual-e5-small@2` → `query-multilingual-e5-small-2`). */
export function queryModelStoreId(profileId: string): string {
  return `query-${profileId.toLowerCase().replace(/[^a-z0-9.-]+/g, '-')}`;
}

/** The immutable Hugging Face download for a pinned version (inference catalog-source.ts). */
export function knowledgeCatalogUrl(catalog: MobileKnowledgeCatalog): string {
  const { repo, revision, path } = catalog.huggingface;
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `https://huggingface.co/datasets/${repo}/resolve/${encodeURIComponent(revision)}/${encoded}?download=true`;
}
