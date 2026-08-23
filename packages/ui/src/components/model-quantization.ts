/**
 * The quantization label lives in core so the service can share its
 * bit-depth predicate — see `packages/core/src/model-quantization.ts`.
 * Re-exported here because every model manager already imports it by this
 * path.
 */
export {
  approximateQuantizationLabel,
  quantizationBitDepths,
  quantizationTitle,
} from '@bendyline/gezel';
