import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCapacitorPackage, writeEmbeddingManifest } from './embedding-package.mjs';
import {
  verifyPluginRuntimeApi,
  verifyProducerSources,
  verifyRuntime,
  verifySpeech,
} from './stage-native.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Capacitor resolves <plugin>/package.json from the consumer. Without this
// export a hoisted npm workspace plugin is silently omitted by cap sync.
const require = createRequire(import.meta.url);
if (require.resolve('@bendyline/gezel-capacitor/package.json') !== path.join(root, 'package.json'))
  throw new Error('Capacitor must be able to resolve the plugin package metadata.');
const ios = await verifyRuntime(path.join(root, 'native/ios'), 'ios');
const android = await verifyRuntime(path.join(root, 'native/android'), 'android');
const repo = path.resolve(root, '../..');
// The package ships the pinned release as built; `native/runtime` changes reach
// it when the pin moves, so drift is reported, never refused. Both platforms'
// manifests record the same sources, so one report covers them.
await verifyProducerSources(ios, repo, console.warn, { allowStale: true });
if (ios.packageVersion !== android.packageVersion)
  throw new Error('Stage the same native version for both platforms before packing.');
// What would break an app is the plugin naming runtime API this release lacks.
await verifyPluginRuntimeApi({ capacitorRoot: root, repoRoot: repo, manifest: ios });
// scripts/publish-package.mjs sets this for a real publish. Offline speech is
// why apps such as DocBlocks take this package; a publish must never ship
// without it, or with a runtime from another release.
if (process.env.GEZEL_CAPACITOR_RELEASE === '1') {
  for (const target of ['ios', 'android']) {
    const speech = await verifySpeech(path.join(root, `native/speech-${target}`), target).catch(
      () => {
        throw new Error(
          `Stage the ${target} speech runtime from native-v${ios.packageVersion} before publishing.`,
        );
      },
    );
    if (speech.packageVersion !== ios.packageVersion)
      throw new Error(
        `The ${target} speech runtime is ${speech.packageVersion}, not native-v${ios.packageVersion}.`,
      );
  }
}
console.log(`Verified Capacitor native payloads (${ios.packageVersion}).`);

await writeEmbeddingManifest(root);
await verifyCapacitorPackage(root);
