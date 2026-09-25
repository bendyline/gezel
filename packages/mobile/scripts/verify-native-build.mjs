import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyNativeBuild } from '../../../native/mobile/verify-build.mjs';
import { verifyRuntime } from '../../capacitor/scripts/stage-native.mjs';

export { verifyNativeBuild };

// Read-only preflight runs before Capacitor rewrites generated platform assets.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const target = process.argv[2];
  if (!['android', 'ios'].includes(target))
    throw new Error('Usage: node scripts/verify-native-build.mjs android|ios');
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  await verifyNativeBuild(
    repo,
    process.env.GEZEL_MOBILE_NATIVE_BUILD ||
      path.join(repo, 'native/mobile/.build', target === 'ios' ? 'ios-bridge' : 'android'),
    target,
  );
  await verifyRuntime(path.join(repo, 'packages/capacitor/native', target), target);
  console.log(`Verified ${target} native sources and payload before sync.`);
}
