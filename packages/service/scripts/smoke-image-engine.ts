/**
 * Exercise an installed image model through a real isolated HTTPS daemon.
 * Run from packages/service with the existing tsx runtime:
 * node --import tsx scripts/smoke-image-engine.ts --binary <sd-server>
 *   --models-home <gezel-home> --model <id> --output <directory>
 *   --prompt <text> [--width 1024] [--height 1024] [--steps 20] [--expect-alpha]
 *
 * Model files are adopted through the read-only overlay and checksum-verified.
 * The temporary product home is removed; PNG and JSON evidence are retained.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { GezelClient, createTrustingFetch } from '@bendyline/gezel-client/node';
import { decodeImage } from '../src/memory/image-pixels.js';
import { startService } from '../src/service.js';

const { values } = parseArgs({
  options: {
    binary: { type: 'string' },
    'models-home': { type: 'string' },
    model: { type: 'string' },
    output: { type: 'string' },
    prompt: { type: 'string' },
    width: { type: 'string', default: '1024' },
    height: { type: 'string', default: '1024' },
    seed: { type: 'string', default: '42' },
    steps: { type: 'string' },
    'expect-alpha': { type: 'boolean', default: false },
  },
});
assert(
  values.binary && values['models-home'] && values.model && values.output && values.prompt,
  'Required: --binary --models-home --model --output --prompt',
);
const width = Number(values.width);
const height = Number(values.height);
const seed = Number(values.seed);
const steps = values.steps === undefined ? undefined : Number(values.steps);
assert(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0);
assert(Number.isInteger(seed));
assert(steps === undefined || (Number.isInteger(steps) && steps > 0));
const output = resolve(values.output);
await mkdir(output, { recursive: true });
const home = await mkdtemp(join(tmpdir(), 'gezel-image-smoke-'));
process.env.GEZEL_HOME = home;
process.env.GEZEL_SD_SERVER_BIN = resolve(values.binary);
process.env.GEZEL_READONLY_MODEL_HOMES = resolve(values['models-home']);
delete process.env.GEZEL_MOCK_PROVIDER;
delete process.env.GEZEL_SD_SERVER_URL;
delete process.env.GEZEL_SHARED_ASSETS_DIR;
delete process.env.GEZEL_SYSTEM_SCOPE;
process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP = '1';
process.env.GEZEL_DISABLE_BACKGROUND_ENRICH = '1';

const service = await startService({
  home,
  role: 'user',
  embeddedInferenceOnly: true,
  machineEngineDiscovery: false,
});
assert(service.cert, 'Expected the real HTTPS transport');
const transport = createTrustingFetch({ cert: service.cert.certPem });
try {
  const client = new GezelClient({
    baseUrl: `https://127.0.0.1:${service.port}`,
    token: service.context.token,
    fetch: transport,
  });
  const installed = await client.listInstalledImageModels();
  assert(
    installed.models.some((model) => model.id === values.model),
    'Model failed adoption',
  );
  const catalog = await client.getCatalogItem('image-model', values.model);
  assert.equal(catalog.manifest.kind, 'image-model');
  const response = await client.generateImage({
    model: values.model,
    prompt: values.prompt,
    width,
    height,
    seed,
    ...(steps === undefined ? {} : { steps }),
    inline: true,
    saveAs: 'smoke/image.png',
  });
  assert.equal(response.meta.model, values.model);
  assert.equal(response.meta.seed, seed);
  assert.equal(response.meta.widthPx, width);
  assert.equal(response.meta.heightPx, height);
  if (catalog.manifest.kind === 'image-model') {
    assert.equal(response.meta.steps, steps ?? catalog.manifest.recommendedSteps);
  }
  const artifact = await service.context.store.readProjectArtifactBinary(
    'default',
    response.artifactPath,
  );
  assert(artifact && response.b64Png && response.workspacePath);
  const png = artifact.data;
  assert.deepEqual(Buffer.from(response.b64Png, 'base64'), png);
  const workspace = await readFile(
    join(home, 'projects/default/workspace', response.workspacePath),
  );
  assert.deepEqual(workspace, png);
  // Retain the actual output even if a pixel-level assertion fails below.
  await writeFile(join(output, 'image.png'), png);
  const decoded = decodeImage(png);
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  let transparentPixels = 0;
  let transparentBackgroundPixels = 0;
  let visiblePixels = 0;
  const minChannels = [255, 255, 255];
  const maxChannels = [0, 0, 0];
  for (let i = 0; i < decoded.data.length; i += 4) {
    const alpha = decoded.data[i + 3]!;
    if (alpha < 255) transparentPixels++;
    if (alpha <= 16) transparentBackgroundPixels++;
    if (alpha > 0) {
      visiblePixels++;
      for (let channel = 0; channel < 3; channel++) {
        minChannels[channel] = Math.min(minChannels[channel]!, decoded.data[i + channel]!);
        maxChannels[channel] = Math.max(maxChannels[channel]!, decoded.data[i + channel]!);
      }
    }
  }
  assert(
    visiblePixels > 0 && maxChannels.some((max, channel) => max > minChannels[channel]!),
    'Image is empty or flat',
  );
  const { b64Png: _inline, ...metadata } = response;
  const evidence = {
    ...metadata,
    prompt: values.prompt,
    binary: resolve(values.binary),
    generatedAt: new Date().toISOString(),
    bytes: png.length,
    sha256: createHash('sha256').update(png).digest('hex'),
    transparentPixels,
    transparentBackgroundPixels,
    visiblePixels,
  };
  await writeFile(join(output, 'result.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  if (values['expect-alpha']) {
    assert(
      transparentBackgroundPixels >= width * height * 0.05,
      'Expected a transparent background covering at least 5% of the image',
    );
  }
  console.log(JSON.stringify({ status: 'passed', output, ...evidence }));
} finally {
  await service.stop();
  await transport.close();
  await rm(home, { recursive: true, force: true });
}
