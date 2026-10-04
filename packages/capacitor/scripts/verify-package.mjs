import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCapacitorPackage, writeEmbeddingManifest } from './embedding-package.mjs';
import { verifyProducerSources, verifyRuntime } from './stage-native.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Capacitor resolves <plugin>/package.json from the consumer. Without this
// export a hoisted npm workspace plugin is silently omitted by cap sync.
const require = createRequire(import.meta.url);
if (require.resolve('@bendyline/gezel-capacitor/package.json') !== path.join(root, 'package.json'))
  throw new Error('Capacitor must be able to resolve the plugin package metadata.');
const ios = await verifyRuntime(path.join(root, 'native/ios'), 'ios');
const android = await verifyRuntime(path.join(root, 'native/android'), 'android');
await verifyProducerSources(ios, path.resolve(root, '../..'));
await verifyProducerSources(android, path.resolve(root, '../..'));
if (ios.packageVersion !== android.packageVersion)
  throw new Error('Stage the same native version for both platforms before packing.');
console.log(`Verified Capacitor native payloads (${ios.packageVersion}).`);

await writeEmbeddingManifest(root);
await verifyCapacitorPackage(root);
