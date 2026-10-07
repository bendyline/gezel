import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  KnowledgeAssetPathSchema,
  MAX_KNOWLEDGE_ASSET_COUNT,
  assetExtension,
  assetKindForExtension,
  knowledgeAssetLimitsProblem,
  maxKnowledgeAssetBytes,
  sniffAssetType,
  svgInertnessProblem,
} from '@bendyline/gezk';

export interface CompileAsset {
  /** Archive path, assets/…, matching the format's asset path grammar. */
  path: string;
  /** Exactly one of absPath / content. */
  absPath?: string;
  content?: Buffer;
  /**
   * Who made it and under which terms (license, author, sourceUrl, …).
   * Recorded on the asset's media rows, where readers surface it.
   */
  attribution?: Record<string, unknown>;
}

export interface PreparedAsset {
  path: string;
  bytes: Buffer;
  sizeBytes: number;
  sha256: string;
  attribution?: Record<string, unknown>;
}

/** Validate before embedding; omitted images must never reach the archive. */
export function prepareAssets(
  assets: CompileAsset[],
  extraFiles: Record<string, string>,
  opts: { invalidAssets?: 'error' | 'warn'; onWarning?: (message: string) => void },
): { assets: PreparedAsset[]; skippedPaths: Set<string> } {
  for (const path of Object.keys(extraFiles)) {
    if (path.startsWith('assets/')) {
      throw new Error(`extraFiles cannot carry '${path}': files under assets/ go through 'assets'`);
    }
  }
  if (assets.length > MAX_KNOWLEDGE_ASSET_COUNT) {
    throw new Error(`${assets.length} assets exceed the limit of ${MAX_KNOWLEDGE_ASSET_COUNT}`);
  }
  const seen = new Set<string>();
  const prepared: PreparedAsset[] = [];
  const skippedPaths = new Set<string>();
  const rejectContent = (path: string, message: string): void => {
    if (opts.invalidAssets !== 'warn') throw new Error(message);
    skippedPaths.add(path);
    opts.onWarning?.(`${message}; skipped (references replaced with their text)`);
  };
  for (const asset of assets) {
    const parsed = KnowledgeAssetPathSchema.safeParse(asset.path);
    if (!parsed.success) throw new Error(`invalid asset path: ${asset.path}`);
    const key = asset.path.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate asset path (case-insensitive): ${asset.path}`);
    seen.add(key);
    if ((asset.content === undefined) === (asset.absPath === undefined)) {
      throw new Error(`asset ${asset.path} must supply exactly one of content / absPath`);
    }
    const bytes = asset.content ?? readFileSync(asset.absPath as string);
    const limit = maxKnowledgeAssetBytes(asset.path);
    if (bytes.byteLength > limit) {
      rejectContent(
        asset.path,
        `asset ${asset.path} is ${bytes.byteLength} bytes; the limit is ${limit}`,
      );
      continue;
    }
    const ext = assetExtension(asset.path);
    const expected = ext ? assetKindForExtension(ext) : null;
    const actual = sniffAssetType(bytes);
    if (expected === null || actual !== expected) {
      rejectContent(
        asset.path,
        `asset ${asset.path}: the leading bytes say ${actual ?? 'unknown'}, the extension says ${expected ?? 'unknown'}`,
      );
      continue;
    }
    if (ext === 'svg') {
      const problem = svgInertnessProblem(bytes);
      if (problem) {
        rejectContent(asset.path, `asset ${asset.path} is not an inert SVG: it ${problem}`);
        continue;
      }
    }
    prepared.push({
      path: asset.path,
      bytes,
      sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(asset.attribution ? { attribution: asset.attribution } : {}),
    });
  }
  const totals = knowledgeAssetLimitsProblem(prepared);
  if (totals) throw new Error(totals);
  return { assets: prepared.sort((a, b) => (a.path < b.path ? -1 : 1)), skippedPaths };
}

/** Keeping the label avoids broken archive references without dropping document text. */
export function omitSkippedAssetReferences(markdown: string, skippedPaths: Set<string>): string {
  if (skippedPaths.size === 0) return markdown;
  return markdown.replace(
    /!?\[((?:\\.|[^\[\]\\\n]|\[[^\]\n]*\])*)\]\(\s*<?(assets\/[^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g,
    (whole, text: string, target: string) => (skippedPaths.has(target) ? text : whole),
  );
}
