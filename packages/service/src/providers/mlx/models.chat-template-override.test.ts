import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type MlxInstallEvent, MlxModelManager } from './models.js';

/**
 * `chatTemplateOverride` exists for the case the recovery pin cannot reach:
 * the repo ships a template and it is the wrong one. Every MLX gemma-4
 * conversion froze Google's pre-2026-07-09 template, which predates the
 * canonical fix for tool-calling loops and turn closures, and no repo
 * choice corrects it — so the catalog has to.
 *
 * What these tests pin down is that the override wins over a *present*
 * template (the recovery ladder deliberately does not), that both
 * resolution paths end up agreeing, and that a file we have no reason to
 * touch keeps the sha256 the download verified.
 */

const OLD_TEMPLATE = '{# stale #}{{ messages }}';
const FIXED_TEMPLATE = '{# canonical #}{%- set preserve_thinking = false -%}{{ messages }}';
const RECOVERY_TEMPLATE = '{# recovery pin #}';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function makeManager(opts: {
  home: string;
  files: Record<string, Buffer>;
  chatTemplateOverride?: string;
  chatTemplate?: string;
}): MlxModelManager {
  const fileList = Object.entries(opts.files).map(([name, bytes]) => ({
    name,
    sha256: sha256(bytes),
    sizeBytes: bytes.length,
  }));

  const catalog = {
    get: async (kind: string, id: string) => {
      if (kind !== 'chat-model') return null;
      return {
        manifest: {
          kind: 'chat-model',
          id,
          name: 'Test MLX Model',
          version: '1',
          mlx: {
            huggingfaceRepo: 'test/repo',
            revision: 'deadbeef',
            approxSizeBytes: fileList.reduce((s, f) => s + f.sizeBytes, 0),
            files: fileList,
            ...(opts.chatTemplateOverride
              ? { chatTemplateOverride: opts.chatTemplateOverride }
              : {}),
            ...(opts.chatTemplate ? { chatTemplate: opts.chatTemplate } : {}),
          },
        },
      } as unknown as Awaited<ReturnType<CatalogService['get']>>;
    },
  } as unknown as CatalogService;

  const fetchImpl = (async (url: string) => {
    const name = (new URL(url).pathname.split('/resolve/deadbeef/')[1] ?? '')
      .split('/')
      .map(decodeURIComponent)
      .join('/');
    const bytes = opts.files[name];
    if (!bytes) return new Response(null, { status: 404, statusText: 'Not Found' });
    return new Response(bytes, {
      status: 200,
      headers: { 'content-length': String(bytes.length) },
    });
  }) as unknown as typeof fetch;

  return new MlxModelManager({ home: opts.home, catalog, fetchImpl });
}

async function drain(iter: AsyncIterable<MlxInstallEvent>): Promise<MlxInstallEvent[]> {
  const events: MlxInstallEvent[] = [];
  for await (const ev of iter) events.push(ev);
  return events;
}

function modelDir(home: string, id: string): string {
  return join(home, 'engines', 'mlx', 'models', id);
}

describe('MlxModelManager — chat template override', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-mlx-tpl-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('replaces a sidecar template the repo actually shipped', async () => {
    const id = 'override-sidecar';
    const manager = makeManager({
      home,
      chatTemplateOverride: FIXED_TEMPLATE,
      files: {
        'config.json': Buffer.from(JSON.stringify({ architectures: ['Gemma3'] })),
        'tokenizer_config.json': Buffer.from(JSON.stringify({ bos_token: '<s>' })),
        'chat_template.jinja': Buffer.from(OLD_TEMPLATE),
        'model.safetensors': Buffer.from('weights'),
      },
    });

    const events = await drain(manager.install(id));
    expect(events.at(-1)).toMatchObject({ type: 'done' });

    const sidecar = await readFile(join(modelDir(home, id), 'chat_template.jinja'), 'utf8');
    expect(sidecar).toBe(FIXED_TEMPLATE);
  });

  it('leaves tokenizer_config untouched when it carried no template', async () => {
    const id = 'override-no-tokenizer-template';
    const tokenizerConfig = Buffer.from(JSON.stringify({ bos_token: '<s>' }));
    const manager = makeManager({
      home,
      chatTemplateOverride: FIXED_TEMPLATE,
      files: {
        'config.json': Buffer.from(JSON.stringify({ architectures: ['Gemma3'] })),
        'tokenizer_config.json': tokenizerConfig,
        'chat_template.jinja': Buffer.from(OLD_TEMPLATE),
        'model.safetensors': Buffer.from('weights'),
      },
    });

    await drain(manager.install(id));

    // Byte-identical to what was downloaded and sha-verified: rewriting it
    // would move the file off its pinned digest for no engine-side gain.
    const onDisk = await readFile(join(modelDir(home, id), 'tokenizer_config.json'));
    expect(onDisk.equals(tokenizerConfig)).toBe(true);
  });

  it('rewrites tokenizer_config when it did carry a template, so both paths agree', async () => {
    const id = 'override-both-paths';
    const manager = makeManager({
      home,
      chatTemplateOverride: FIXED_TEMPLATE,
      files: {
        'config.json': Buffer.from(JSON.stringify({ architectures: ['Gemma3'] })),
        'tokenizer_config.json': Buffer.from(
          JSON.stringify({ bos_token: '<s>', chat_template: OLD_TEMPLATE }),
        ),
        'model.safetensors': Buffer.from('weights'),
      },
    });

    await drain(manager.install(id));

    const dir = modelDir(home, id);
    const parsed = JSON.parse(await readFile(join(dir, 'tokenizer_config.json'), 'utf8'));
    expect(parsed.chat_template).toBe(FIXED_TEMPLATE);
    // Untouched keys survive the merge.
    expect(parsed.bos_token).toBe('<s>');
    // The sidecar is written too — it is what mlx_vlm actually loads.
    await expect(readFile(join(dir, 'chat_template.jinja'), 'utf8')).resolves.toBe(FIXED_TEMPLATE);
  });

  it('wins over the recovery pin rather than racing it', async () => {
    const id = 'override-beats-recovery';
    const manager = makeManager({
      home,
      chatTemplateOverride: FIXED_TEMPLATE,
      chatTemplate: RECOVERY_TEMPLATE,
      files: {
        'config.json': Buffer.from(JSON.stringify({ architectures: ['Gemma3'] })),
        'tokenizer_config.json': Buffer.from(JSON.stringify({ bos_token: '<s>' })),
        'model.safetensors': Buffer.from('weights'),
      },
    });

    await drain(manager.install(id));

    const dir = modelDir(home, id);
    await expect(readFile(join(dir, 'chat_template.jinja'), 'utf8')).resolves.toBe(FIXED_TEMPLATE);
    const parsed = JSON.parse(await readFile(join(dir, 'tokenizer_config.json'), 'utf8'));
    expect(parsed.chat_template).toBeUndefined();
  });

  it('leaves the upstream sidecar alone when no override is pinned', async () => {
    const id = 'no-override';
    const manager = makeManager({
      home,
      files: {
        'config.json': Buffer.from(JSON.stringify({ architectures: ['Gemma3'] })),
        'tokenizer_config.json': Buffer.from(JSON.stringify({ bos_token: '<s>' })),
        'chat_template.jinja': Buffer.from(OLD_TEMPLATE),
        'model.safetensors': Buffer.from('weights'),
      },
    });

    await drain(manager.install(id));

    await expect(
      readFile(join(modelDir(home, id), 'chat_template.jinja'), 'utf8'),
    ).resolves.toBe(OLD_TEMPLATE);
  });
});
