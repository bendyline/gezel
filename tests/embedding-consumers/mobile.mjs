import assert from 'node:assert/strict';
import {
  createRuntimeEmbedding,
  mobileCatalog,
  mobileCatalogVersion,
} from '@bendyline/gezel-capacitor';
import { verifyCapacitorPackage } from '@bendyline/gezel-capacitor/packaging';
const compatibility = await verifyCapacitorPackage();
assert.equal(compatibility.native.ios.abi, compatibility.native.android.abi);
assert.ok(compatibility.native.ios.privacyManifests.length >= 2);
assert.ok(mobileCatalog.length > 0 && mobileCatalogVersion);
let released = 0;
const runtime = {
  providers: async () => ({
    providers: [
      {
        id: 'apple-foundation-models',
        name: 'Apple',
        locality: 'on-device',
        availability: 'available',
        contextTokens: 4096,
        maxOutputTokens: 1024,
        capabilities: {
          text: true,
          tools: true,
          structuredOutput: false,
          images: false,
          foregroundOnly: true,
        },
      },
    ],
  }),
  listModels: async () => ({ models: [] }),
  listModelDownloads: async () => ({ downloads: [] }),
  releaseModel: async () => {
    released++;
  },
  addListener: async () => ({ remove: async () => {} }),
  cancel: async () => {},
  generate: async () => ({ text: 'portable consumer passed', stopReason: 'stop' }),
};
const host = createRuntimeEmbedding(runtime);
await host.setEnabled(true);
const model = (await host.models.list())[0];
assert.equal(model.name, 'Apple Foundation Models');
assert.equal(model.capabilities.tools, false);
assert.equal(model.native_capabilities.tools, true);
const reply = await host.streamText({
  model: model.id,
  messages: [{ role: 'user', content: 'hello' }],
});
assert.equal(reply.text, 'portable consumer passed');
await host.suspend();
assert.equal(released, 1);
await host.close();
assert.equal(released, 1);
process.stdout.write('External Capacitor consumer and installed-package verification passed\n');
