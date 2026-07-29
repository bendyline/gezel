/**
 * Transformers.js currently imports `sharp` at module load even when the
 * caller only uses text or audio pipelines. Gezel supports those pipelines
 * but deliberately does not expose Transformers.js vision pipelines, so the
 * native Sharp/libvips runtime would otherwise be unused packaged weight.
 */
export const gezelSharpCompatibilityStub = true;

export default function sharp() {
  const error = new Error(
    'Transformers.js image processing is not bundled with Gezel. ' +
      'Use Gezel’s dedicated image providers instead.',
  );
  error.code = 'GEZEL_TRANSFORMERS_IMAGE_UNSUPPORTED';
  throw error;
}
