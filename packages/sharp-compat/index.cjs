'use strict';

/**
 * CommonJS twin of index.mjs. Transformers.js publishes both ESM and CommonJS
 * Node entry points, so both must resolve the same deliberate no-image guard.
 */
function sharp() {
  const error = new Error(
    'Transformers.js image processing is not bundled with Gezel. ' +
      'Use Gezel’s dedicated image providers instead.',
  );
  error.code = 'GEZEL_TRANSFORMERS_IMAGE_UNSUPPORTED';
  throw error;
}

sharp.gezelSharpCompatibilityStub = true;

module.exports = sharp;
