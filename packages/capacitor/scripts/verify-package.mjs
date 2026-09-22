import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyProducerSources, verifyRuntime } from './stage-native.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ios = await verifyRuntime(path.join(root, 'native/ios'), 'ios');
const android = await verifyRuntime(path.join(root, 'native/android'), 'android');
await verifyProducerSources(ios, path.resolve(root, '../..'));
await verifyProducerSources(android, path.resolve(root, '../..'));
if (ios.packageVersion !== android.packageVersion)
  throw new Error('Stage the same native version for both platforms before packing.');
console.log(`Verified Capacitor native payloads (${ios.packageVersion}).`);
