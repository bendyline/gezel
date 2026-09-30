/**
 * `supervision.keurmeester` — marker behavior enabling Keurmeester
 * supervision for sessions running on this model profile. No hooks:
 * the KeurmeesterManager checks for this marker (or the production
 * `config.keurmeester.enabled` toggle) in its consult predicate.
 *
 * Deliberately in NO tier's defaults — supervision sends transcript
 * excerpts to a cloud provider, so it is opt-in only. The eval harness
 * switches it on per-trial via `GEZEL_FORCE_BEHAVIORS=supervision.keurmeester`
 * (control vs treatment with no catalog edits); production installs use
 * the Settings toggle instead.
 */

import type { Behavior } from '../types.js';

export const SupervisionKeurmeester: Behavior = {
  id: 'supervision.keurmeester',
  description:
    'Enable Keurmeester supervision: consult a frontier model when this model exhausts its recovery budget',
};
