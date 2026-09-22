/**
 * `kokoro-js` reaches for `phonemizer` to turn text into phonemes, and the
 * real package embeds eSpeak NG compiled to WebAssembly. eSpeak NG is
 * GPL-3; Gezel is MIT and ships through the app stores, so that code must
 * not be in the bundle.
 *
 * Gezel never needs it: the daemon phonemizes with the shared
 * `@bendyline/gezel/kokoro` frontend and calls kokoro-js's
 * `generate_from_ids`, which does no text handling of its own. This stub
 * occupies the dependency slot so the GPL runtime is never installed, and
 * fails loudly if some future code path reaches for it.
 */
export const gezelPhonemizerCompatibilityStub = true;

function unsupported() {
  const error = new Error(
    'phonemizer (eSpeak NG) is deliberately not bundled with Gezel. ' +
      'Phonemize with @bendyline/gezel/kokoro and call generate_from_ids instead.',
  );
  error.code = 'GEZEL_PHONEMIZER_UNSUPPORTED';
  throw error;
}

export function phonemize() {
  return unsupported();
}

export default { phonemize };
