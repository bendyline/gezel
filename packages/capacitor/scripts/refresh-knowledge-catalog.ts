/**
 * Producer-only refresh of the knowledge catalogs a device can install: the
 * latest unyanked version of each Gilde `knowledge-catalog` item, pinned the
 * way the daemon's installer trusts it (Hugging Face commit + path + sha256).
 * Separate from refresh-catalog.ts so the chat-model snapshot moves on its own.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { knowledgeEmbeddingProfile } from '../../knowledge/src/profiles/registry.js';

const require = createRequire(new URL('../../catalog/package.json', import.meta.url));
const gildePath = require.resolve('@bendyline/gilde/package.json');
const { version } = JSON.parse(await readFile(gildePath, 'utf8')) as { version: string };
const root = join(dirname(gildePath), 'data', 'knowledge-catalogs');
// Gilde manifests are JSON read field by field; their schema lives in the catalog package.
const read = async (file: string) =>
  // biome-ignore lint/suspicious/noExplicitAny: untyped Gilde JSON
  JSON.parse(await readFile(file, 'utf8')) as Record<string, any>;

const catalogs = [];
for (const shelf of (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory())) {
  for (const entry of await readdir(join(root, shelf.name), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = join(root, shelf.name, entry.name);
    const item = await read(join(folder, 'manifest.json'));
    if (item.kind !== 'knowledge-catalog') continue;
    const yanked = new Set<string>(item.yankedVersions ?? []);
    const versions = [];
    for (const name of await readdir(join(folder, 'versions')).catch(() => [])) {
      if (yanked.has(name)) continue;
      versions.push(await read(join(folder, 'versions', name, 'manifest.json')));
    }
    const latest = versions
      .filter((v) => v.huggingface && /^[a-f0-9]{64}$/.test(v.sha256))
      .sort((a, b) => String(b.releasedAt).localeCompare(String(a.releasedAt)))[0];
    if (!latest) continue;
    catalogs.push({
      id: item.id,
      publisherId: item.publisherId,
      name: item.name,
      description: item.description,
      language: item.language,
      license: item.license,
      ...(item.licenseUrl ? { licenseUrl: item.licenseUrl } : {}),
      ...(item.category ? { category: item.category } : {}),
      version: latest.version,
      huggingface: latest.huggingface,
      sha256: latest.sha256,
      archiveBytes: latest.archiveBytes,
      documents: latest.documents,
      chunks: latest.chunks,
      embeddingProfile: latest.embeddingProfile,
    });
  }
}
catalogs.sort((a, b) => a.name.localeCompare(b.name));

/**
 * Each profile's query model, as the device downloads it: the profile's
 * pinned graph and tokenizer (their digests are the profile's own) plus the
 * tokenizer config the tokenizer needs, hashed here once.
 */
const queryModels = [];
for (const id of [...new Set(catalogs.map((c) => c.embeddingProfile.id as string))].sort()) {
  const profile = knowledgeEmbeddingProfile(id);
  if (!profile) throw new Error(`Unregistered embedding profile ${id}`);
  const { repo, revision, onnxFile, onnxDigest } = profile.model;
  const url = (path: string) => `https://huggingface.co/${repo}/resolve/${revision}/${path}`;
  const sizes = new Map<string, number>();
  for (const folder of ['', 'onnx']) {
    const response = await fetch(
      `https://huggingface.co/api/models/${repo}/tree/${revision}/${folder}`,
    );
    for (const entry of (await response.json()) as { path: string; size: number }[])
      sizes.set(entry.path, entry.size);
  }
  const config = new Uint8Array(await (await fetch(url('tokenizer_config.json'))).arrayBuffer());
  const pinned = (path: string, digest: string | undefined) => {
    if (!digest?.startsWith('sha256:') || !sizes.has(path))
      throw new Error(`Unpinned ${id} ${path}`);
    return { name: path, url: url(path), sha256: digest.slice(7), size: sizes.get(path)! };
  };
  queryModels.push({
    id,
    queryInstruction: profile.queryInstruction,
    pooling: profile.pooling,
    normalized: profile.normalized,
    dimensions: profile.dimensions,
    maxTokens: profile.maxTokens,
    model: onnxFile,
    tokenizer: profile.tokenizer.file,
    files: [
      pinned(onnxFile, onnxDigest),
      pinned(profile.tokenizer.file, profile.tokenizer.digest),
      {
        name: 'tokenizer_config.json',
        url: url('tokenizer_config.json'),
        sha256: createHash('sha256').update(config).digest('hex'),
        size: config.byteLength,
      },
    ],
  });
}
await writeFile(
  new URL('../src/knowledge-catalog.json', import.meta.url),
  `${JSON.stringify({ package: '@bendyline/gilde', version, catalogs, queryModels }, null, 2)}\n`,
);
