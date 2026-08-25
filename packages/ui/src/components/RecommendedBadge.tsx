import type { LicenseClass } from '@bendyline/gezel';
import { isRecommendedModel } from '@bendyline/gezel';

/**
 * ★ Recommended pill for a model card. Shown when the model passes core's
 * `isRecommendedModel` gate — curated `recoScore`, fully-open license, no
 * `retired` tag, and no explicit `supportsTools: false`. That is the exact
 * predicate the first-run picker uses (see `packages/core/src/recommendation.ts`),
 * so the badge and the auto-pick can never disagree.
 *
 * The prop is the structural subset every model manifest satisfies (all three
 * fields optional), so this drops into any model screen — chat, image, video,
 * audio — and simply renders nothing for un-scored, restricted, retired, or
 * tool-less models.
 */
export function RecommendedBadge({
  manifest,
}: {
  manifest: {
    recoScore?: number;
    licenseClass?: LicenseClass;
    supportsTools?: boolean;
    tags?: readonly string[];
  };
}) {
  if (!isRecommendedModel(manifest)) return null;
  return (
    <span
      className="reco-badge"
      title="A recommended on-device model — fully open, tool-capable, and a good default for its size."
    >
      ★ Recommended
    </span>
  );
}
