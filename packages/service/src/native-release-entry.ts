/**
 * `@bendyline/gezel-service/native-release` — the native engine release this
 * service build pins, as data.
 *
 * An application that hosts Gezel (`@bendyline/gezel-app-sdk/host`) can ship
 * the engines beside the daemon and pass them as `host.nativeBinDir`, so a
 * first run needs no engine download. Staging that directory at build time
 * needs exactly these values: which release to fetch, and the digests to
 * verify it against. Importing them from the service being bundled keeps the
 * two from drifting — engines from another release may not accept the flags
 * this daemon passes them.
 *
 * Deliberately a leaf: no daemon code is loaded by importing it.
 */

export {
  NATIVE_ENGINE_ARCHIVE_SHA256,
  NATIVE_ENGINE_MACOS_NOTARIZED,
  NATIVE_ENGINE_RELEASE,
  SHA256SUMS_DIGEST,
} from './engines/native-manifest.js';
