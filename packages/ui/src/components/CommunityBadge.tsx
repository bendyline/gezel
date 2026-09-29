import { Tooltip } from '../primitives/index.js';
import { COMMUNITY_BADGE_HINT, COMMUNITY_BADGE_LABEL } from './catalog-provenance.js';

/**
 * Small uppercase `community` badge for an unreviewed catalog entry. The
 * neutral badge recipe (the sibling of search's `related` and chat's
 * `automatic`): a label that says where something came from, not a warning
 * colour, because most community entries are fine — they are just unvetted.
 * The hover explains it; surfaces that list community entries also carry the
 * same explanation as visible text, so it never depends on a hover alone.
 */
export function CommunityBadge() {
  return (
    <Tooltip.Hint text={COMMUNITY_BADGE_HINT}>
      <span className="catalog-item-community">{COMMUNITY_BADGE_LABEL}</span>
    </Tooltip.Hint>
  );
}
