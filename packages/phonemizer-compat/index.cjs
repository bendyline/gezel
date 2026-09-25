/** CommonJS face of the stub; see index.mjs for why this package exists. */
'use strict';

function unsupported() {
  const error = new Error(
    'phonemizer (eSpeak NG) is deliberately not bundled with Gezel. ' +
      'Phonemize with @bendyline/gezel/kokoro and call generate_from_ids instead.',
  );
  error.code = 'GEZEL_PHONEMIZER_UNSUPPORTED';
  throw error;
}

exports.gezelPhonemizerCompatibilityStub = true;
exports.phonemize = unsupported;
module.exports.default = { phonemize: unsupported };
