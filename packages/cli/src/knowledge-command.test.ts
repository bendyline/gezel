import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeEmbeddingProfile } from '@bendyline/gezel';
import type { ProfileEmbedder } from '@bendyline/gezel-knowledge';
import {
  CatalogHandle,
  extractGezkVerified,
  generateKnowledgeSigningKeyPair,
  readGezkManifest,
  verifyManifestSignature,
} from '@bendyline/gezel-knowledge';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  embeddingRuntimeMissingMessage,
  runKnowledgeBuild,
  runKnowledgeInit,
  runKnowledgeInspect,
  runKnowledgeNearby,
  runKnowledgeSearch,
  runKnowledgeValidate,
} from './knowledge-command.js';

const FAKE_PROFILE: KnowledgeEmbeddingProfile = {
  id: 'bge-small-en-v1.5@1',
  model: { repo: 'test/hash', revision: 'fixture' },
  tokenizer: { kind: 'whitespace' },
  pooling: 'mean',
  normalized: true,
  dimensions: 384,
  maxTokens: 512,
  queryInstruction: '',
  passageInstruction: '',
  vectorEncoding: 'bit+int8',
  distance: { stage1: 'hamming', stage2: 'cosine' },
  quantization: {
    int8: { method: 'symmetric-linear', scale: 127 },
    binary: { method: 'sign', threshold: 0, packing: 'lsb-first' },
  },
};

function hashVector(text: string, dims = 384): number[] {
  const out = new Array<number>(dims);
  let hash = createHash('sha256').update(text, 'utf8').digest();
  let offset = 0;
  for (let i = 0; i < dims; i++) {
    if (offset >= hash.length) {
      hash = createHash('sha256').update(hash).digest();
      offset = 0;
    }
    out[i] = (hash.readInt8(offset) + 0.5) / 128;
    offset++;
  }
  return out;
}

const fakeEmbedder: ProfileEmbedder = {
  profile: FAKE_PROFILE,
  verification: { status: 'unpinned', checks: [] },
  embed: async (texts) => texts.map((t) => hashVector(t)),
  embedQuery: async (text) => Float32Array.from(hashVector(text)),
  countTokens: (text) => (text.trim() ? text.trim().split(/\s+/).length : 0),
  dispose: async () => {},
};

const deps = { createEmbedder: async () => fakeEmbedder };

let dir: string;
let catalogDir: string;
let archivePath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-knowledge-cli-'));
  catalogDir = join(dir, 'field-notes');
  await runKnowledgeInit(catalogDir);
  await mkdir(join(catalogDir, 'content', 'Joinery'), { recursive: true });
  await writeFile(
    join(catalogDir, 'content', 'Joinery', 'dovetails.md'),
    '---\nlocations:\n  - id: seattle\n    latitude: 47.6062\n    longitude: -122.3321\n    role: subject\n---\n# Dovetail Joints\n\nTails and pins interlock for a mechanically strong corner.\n',
  );
  await runKnowledgeBuild(catalogDir, {}, deps);
  archivePath = join(catalogDir, 'field-notes-1.0.0.gezk');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('gezel knowledge (offline)', () => {
  it('init scaffolds once and refuses to overwrite', async () => {
    expect((await stat(join(catalogDir, 'catalog.json'))).isFile()).toBe(true);
    await expect(runKnowledgeInit(catalogDir)).rejects.toThrow(/already exists/);
  });

  it('init catalogs a folder that already holds Markdown in place', async () => {
    const docsDir = join(dir, 'existing-docs');
    await mkdir(join(docsDir, 'articles', 'guide'), { recursive: true });
    await writeFile(join(docsDir, 'articles', 'guide', 'intro.md'), '# Intro\n');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runKnowledgeInit(docsDir);
    expect((await stat(join(docsDir, 'catalog.json'))).isFile()).toBe(true);
    // A scaffolded content/ would shadow the tree: build prefers it.
    await expect(stat(join(docsDir, 'content'))).rejects.toThrow();
  });

  it('build produced a verifiable archive', async () => {
    expect((await stat(archivePath)).size).toBeGreaterThan(0);
    const manifest = await readGezkManifest(archivePath);
    expect(manifest.id).toBe('field-notes');
    expect(manifest.counts.documents).toBe(2);
    expect(manifest.topics.length).toBeGreaterThanOrEqual(2);
    expect(manifest.signature).toBeUndefined();
  });

  it.each([true, false])(
    'build warns and skips mislabeled images (valid image retained: %s)',
    async (keepValidImage) => {
      const root = join(dir, `bad-assets-${keepValidImage}`);
      await runKnowledgeInit(root);
      await writeFile(join(root, 'content', 'f5-logo.png'), Buffer.from([0xff, 0xd8, 0xff]));
      if (keepValidImage) {
        await writeFile(
          join(root, 'content', 'good.png'),
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
            'base64',
          ),
        );
      }
      const markdown = `# Photos\n\nText before the image. ![F5 logo](f5-logo.png) Text after the image.\n${keepValidImage ? '\n![Good image](good.png)\n' : ''}`;
      await writeFile(join(root, 'content', 'photos.md'), markdown);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const outputPath = join(root, 'output.gezk');
      await runKnowledgeBuild(root, { out: outputPath }, deps);
      expect(warn).toHaveBeenCalledWith(
        'warning: asset assets/f5-logo.png: the leading bytes say jpeg, the extension says png; skipped (references replaced with their text)',
      );
      const manifest = await readGezkManifest(outputPath);
      expect(manifest.counts.assets).toBe(keepValidImage ? 1 : 0);
      expect(manifest.files.some((file) => file.path === 'assets/f5-logo.png')).toBe(false);
      const extracted = join(root, 'extracted');
      await extractGezkVerified(outputPath, extracted);
      const handle = CatalogHandle.open(extracted);
      try {
        const body = handle.getDocument('photos')?.markdown;
        expect(body).toContain('Text before the image. F5 logo Text after the image.');
        expect(body).not.toContain('assets/f5-logo.png');
        if (keepValidImage) expect(body).toContain('![Good image](assets/good.png)');
        expect(handle.searchDocumentsFts('photos', 5).map((hit) => hit.documentId)).toContain(
          'photos',
        );
      } finally {
        handle.close();
      }
      await expect(runKnowledgeValidate(outputPath, { deep: true })).resolves.toBeUndefined();
      expect(await readFile(join(root, 'content', 'photos.md'), 'utf8')).toBe(markdown);
    },
  );

  it('build warns and skips an oversized GIF while preserving its document', async () => {
    const root = join(dir, 'oversized-image');
    const imagePath = 'articles/cyclecloud/images/node-detail-error-flow.gif';
    await runKnowledgeInit(root);
    await mkdir(join(root, 'content', 'articles', 'cyclecloud', 'images'), { recursive: true });
    const image = Buffer.alloc(12_218_702);
    image.write('GIF89a', 'ascii');
    await writeFile(join(root, 'content', imagePath), image);
    const markdown = `# Error Flow\n\nBefore ![Error flow](${imagePath}) after.\n`;
    await writeFile(join(root, 'content', 'flow.md'), markdown);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const outputPath = join(root, 'output.gezk');
    await runKnowledgeBuild(root, { out: outputPath }, deps);
    expect(warn).toHaveBeenCalledWith(
      `warning: asset assets/${imagePath} is 12218702 bytes; the limit is 8388608; skipped (references replaced with their text)`,
    );
    const manifest = await readGezkManifest(outputPath);
    expect(manifest.counts.assets).toBe(0);
    expect(manifest.files.some((file) => file.path.startsWith('assets/'))).toBe(false);
    const extracted = join(root, 'extracted');
    await extractGezkVerified(outputPath, extracted);
    const handle = CatalogHandle.open(extracted);
    try {
      expect(handle.getDocument('flow')?.markdown).toContain('Before Error flow after.');
      expect(handle.searchDocumentsFts('Error Flow', 5).map((hit) => hit.documentId)).toContain(
        'flow',
      );
    } finally {
      handle.close();
    }
    await expect(runKnowledgeValidate(outputPath, { deep: true })).resolves.toBeUndefined();
    expect(await readFile(join(root, 'content', 'flow.md'), 'utf8')).toBe(markdown);
    expect((await stat(join(root, 'content', imagePath))).size).toBe(image.byteLength);
  });

  it('build --skip-images produces a searchable text-only catalog without reading images', async () => {
    const root = join(dir, 'skip-images');
    await runKnowledgeInit(root);
    const markdown = '# Pictures\n\nBefore ![F5 logo](logo.png) after. ![Missing](missing.png)\n';
    await writeFile(join(root, 'content', 'pictures.md'), markdown);
    await mkdir(join(root, 'content', 'logo.png'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const outputPath = join(root, 'output.gezk');
    await runKnowledgeBuild(root, { out: outputPath, skipImages: true }, deps);
    expect(warn).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain('0 assets');
    const manifest = await readGezkManifest(outputPath);
    expect(manifest.counts.assets).toBe(0);
    expect(manifest.files.some((file) => file.path.startsWith('assets/'))).toBe(false);
    const extracted = join(root, 'extracted');
    await extractGezkVerified(outputPath, extracted);
    const handle = CatalogHandle.open(extracted);
    try {
      expect(handle.getDocument('pictures')?.markdown).toContain('Before F5 logo after. Missing');
      expect(handle.searchDocumentsFts('pictures', 5).map((hit) => hit.documentId)).toContain(
        'pictures',
      );
    } finally {
      handle.close();
    }
    await expect(runKnowledgeValidate(outputPath, { deep: true })).resolves.toBeUndefined();
    expect(await readFile(join(root, 'content', 'pictures.md'), 'utf8')).toBe(markdown);
  });

  it('build embeds referenced audio for a multimodal profile and records per-asset attribution', async () => {
    const root = join(dir, 'media-catalog');
    await runKnowledgeInit(root);
    const config = JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8'));
    config.profile = 'embeddinggemma-2-512@1';
    config.assets = {
      'sounds/chime.wav': {
        license: 'CC0-1.0',
        author: 'Field recordist',
        source: 'https://example.org/chime',
      },
    };
    await writeFile(join(root, 'catalog.json'), JSON.stringify(config, null, 2));
    await mkdir(join(root, 'content', 'sounds'), { recursive: true });
    const wav = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([36, 0, 0, 0]),
      Buffer.from('WAVEfmt '),
      Buffer.from([16, 0, 0, 0, 1, 0, 1, 0, 0x80, 0x3e, 0, 0, 0, 0x7d, 0, 0, 2, 0, 16, 0]),
      Buffer.from('data'),
      Buffer.from([0, 0, 0, 0]),
    ]);
    await writeFile(join(root, 'content', 'sounds', 'chime.wav'), wav);
    await writeFile(
      join(root, 'content', 'bells.md'),
      '# Bells\n\nA brass bell rings once.\n\n![A brass bell chiming](sounds/chime.wav)\n',
    );
    const { knowledgeEmbeddingProfile } = await import('@bendyline/gezel-knowledge');
    const gemma = knowledgeEmbeddingProfile('embeddinggemma-2-512@1');
    if (!gemma) throw new Error('embeddinggemma-2-512@1 is not registered');
    const media: Array<{ path: string; modality: string }> = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const outputPath = join(root, 'output.gezk');
    await runKnowledgeBuild(
      root,
      { out: outputPath },
      {
        createEmbedder: async () => ({
          ...fakeEmbedder,
          profile: gemma,
          embed: async (texts) => texts.map((t) => hashVector(t, 768)),
        }),
        createMediaEmbedder: async () => ({
          embedMedia: async (request) => {
            media.push({ path: request.path, modality: request.modality });
            return [{ vector: hashVector(request.path, 768), startMs: 0, endMs: 1000 }];
          },
          dispose: async () => {},
        }),
      },
    );
    expect(media).toEqual([{ path: 'assets/sounds/chime.wav', modality: 'audio' }]);
    expect(log.mock.calls.flat().join('\n')).toContain('1 media rows');
    const manifest = await readGezkManifest(outputPath);
    expect(manifest.formatVersion).toBe('0.8');
    expect(manifest.counts.media).toEqual({ image: 0, video: 0, audio: 1 });
    const extracted = join(root, 'extracted');
    await extractGezkVerified(outputPath, extracted);
    const handle = CatalogHandle.open(extracted);
    try {
      const [hit] = handle.searchMedia(
        Float32Array.from(hashVector('assets/sounds/chime.wav', 768)).slice(0, 512),
        {
          perModality: 1,
        },
      );
      expect(hit?.media).toMatchObject({
        modality: 'audio',
        assetPath: 'assets/sounds/chime.wav',
        startMs: 0,
        endMs: 1000,
        attribution: { license: 'CC0-1.0', author: 'Field recordist' },
      });
      const asset = handle.assetFile('assets/sounds/chime.wav');
      expect(asset).toMatchObject({ contentType: 'audio/wav', sizeBytes: wav.byteLength });
    } finally {
      handle.close();
    }
    await expect(runKnowledgeValidate(outputPath, { deep: true })).resolves.toBeUndefined();
  });

  it('validate --deep passes on the built archive', async () => {
    await expect(runKnowledgeValidate(archivePath, { deep: true })).resolves.toBeUndefined();
  });

  it('validate fails loudly on a tampered archive', async () => {
    const tamperedPath = join(dir, 'tampered.gezk');
    const bytes = Buffer.from(await readFile(archivePath));
    bytes[Math.floor(bytes.length / 2)] = (bytes[Math.floor(bytes.length / 2)] as number) ^ 0xff;
    await writeFile(tamperedPath, bytes);
    await expect(runKnowledgeValidate(tamperedPath, {})).rejects.toThrow(/verification failed/);
  });

  it('inspect prints the catalog summary', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runKnowledgeInspect(archivePath);
    const output = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('field-notes@1.0.0');
    expect(output).toContain('unsigned');
    expect(output).toContain('bge-small-en-v1.5@1');
  });

  it('search finds documents and cites knowledge:// URIs', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runKnowledgeSearch(archivePath, 'dovetail', { limit: 5 }, deps);
    const output = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('Dovetail Joints');
    expect(output).toContain('knowledge://field-notes/');
  });

  it('semantic search reranks through the vector path', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runKnowledgeSearch(
      archivePath,
      'Tails and pins interlock for a mechanically strong corner.',
      { semantic: true, limit: 5 },
      deps,
    );
    const output = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('semantic');
    expect(output).toContain('#chunk=');
  });

  it('discovers authored locations offline and applies radius filters to text search', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const radius = { latitude: 47.6062, longitude: -122.3321, radiusMeters: 50_000 };
    await runKnowledgeNearby(archivePath, radius, { json: true, limit: 1 });
    const page = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(page.total).toBe(1);
    expect(page.documents[0]?.title).toBe('Dovetail Joints');
    expect(page.documents[0]?.distanceMeters).toBe(0);
    expect(page.documents[0]?.matchedLocation.id).toBe('seattle');
    log.mockClear();
    await runKnowledgeSearch(archivePath, 'dovetail', radius, deps);
    expect(log.mock.calls.flat().join('\n')).toContain('Dovetail Joints');
    log.mockClear();
    await runKnowledgeSearch(
      archivePath,
      'dovetail',
      { ...radius, latitude: 0, longitude: 0 },
      deps,
    );
    expect(log.mock.calls.flat().join('\n')).not.toContain('Dovetail Joints');
    await expect(
      runKnowledgeSearch(archivePath, 'dovetail', { latitude: 47.6 }, deps),
    ).rejects.toThrow(/together/);
  });

  it('build --sign-key produces a verifiable signed manifest', async () => {
    const keys = generateKnowledgeSigningKeyPair();
    const keyPath = join(dir, 'signing-key.pem');
    await writeFile(keyPath, keys.privateKeyPem, 'utf8');
    const signedPath = join(dir, 'signed.gezk');
    await runKnowledgeBuild(catalogDir, { out: signedPath, signKey: keyPath }, deps);
    const manifest = await readGezkManifest(signedPath);
    expect(manifest.signature?.keyId).toBe(keys.keyId);
    expect(
      verifyManifestSignature(manifest, [{ keyId: keys.keyId, publicKeyPem: keys.publicKeyPem }]),
    ).toEqual({ ok: true, keyId: keys.keyId });
  });
});

describe('gezel knowledge build reads the outline a documentation tree already has', () => {
  let projectDir: string;

  beforeAll(async () => {
    projectDir = join(dir, 'mkdocs-site');
    await mkdir(join(projectDir, 'docs', 'guide'), { recursive: true });
    await writeFile(
      join(projectDir, 'catalog.json'),
      JSON.stringify({
        id: 'mkdocs-site',
        version: '1.0.0',
        name: 'MkDocs Site',
        language: 'en',
        publisher: { id: 'gezel-tests', name: 'Gezel Tests' },
        license: { name: 'MIT', attributionRequired: false },
      }),
    );
    await writeFile(
      join(projectDir, 'mkdocs.yml'),
      [
        'site_name: Site',
        'nav:',
        '  - Home: index.md',
        '  - User Guide:',
        '      - guide/writing.md',
        '      - Styling: guide/styling.md',
        'markdown_extensions:',
        '  - pymdownx.superfences:',
        '      custom_fences:',
        '        - name: mermaid',
        '          format: !!python/name:pymdownx.superfences.fence_code_format',
        '',
      ].join('\n'),
    );
    await writeFile(join(projectDir, 'docs', 'index.md'), '# Welcome\n\nThe front page.\n');
    await writeFile(
      join(projectDir, 'docs', 'guide', 'writing.md'),
      '# Writing\n\nHow to write.\n',
    );
    await writeFile(join(projectDir, 'docs', 'guide', 'styling.md'), '# Styles\n\nHow to style.\n');
    await runKnowledgeBuild(projectDir, {}, deps);
  });

  it('finds docs_dir and files pages by the mkdocs nav without configuration', async () => {
    const manifest = await readGezkManifest(join(projectDir, 'mkdocs-site-1.0.0.gezk'));
    expect(manifest.counts.documents).toBe(3);
    expect(manifest.topics.map((t) => t.name).sort()).toEqual(['General', 'User Guide']);
    const guide = manifest.topics.find((t) => t.name === 'User Guide');
    expect(guide?.sortKey).toBe('2147483649');
  });
});

describe('embeddingRuntimeMissingMessage', () => {
  it('gives the exact install command for both kinds of npm install', () => {
    const message = embeddingRuntimeMissingMessage();
    expect(message).toContain('npm install -g @huggingface/transformers@^4.3.1');
    expect(message).toMatch(/^ {2}npm install @huggingface\/transformers@\^4\.3\.1 /m);
    expect(message).toContain('full-text search works without it');
  });
});
