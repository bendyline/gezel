/**
 * The knowledge profile media search embeds with — a leaf module, so the
 * image-embed worker's import graph never reaches the installer (and through
 * it the provider layer's download helper).
 */
import { EMBEDDINGGEMMA_2_512_1 } from '@bendyline/gezel-knowledge';

export const MEDIA_SEARCH_PROFILE = EMBEDDINGGEMMA_2_512_1;
