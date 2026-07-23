import type { LicenseClass } from '@bendyline/gezel';

/**
 * ★ Recommended pill for a model card. Shown when a model carries a
 * hand-curated `recoScore` AND is fully open (`licenseClass === 'open'`) — the
 * exact two-part gate the first-run picker uses (see
 * `packages/core/src/recommendation.ts`), so the badge and the auto-pick never
 * disagree, and a stray score on a restricted model is ignored.
 *
 * The prop is the structural subset every model manifest satisfies
 * (`recoScore`/`licenseClass` are both optional), so this drops into any model
 * screen — chat, image, video, audio — and simply renders nothing for
 * un-scored or restricted models.
 */
export function RecommendedBadge({
  manifest,
}: {
  manifest: { recoScore?: number; licenseClass?: LicenseClass };
}) {
  if (manifest.recoScore == null || manifest.licenseClass !== 'open') return null;
  return (
    <span
      className="reco-badge"
      title="A recommended on-device model — fully open, and a good default for its size."
    >
      ★ Recommended
    </span>
  );
}
