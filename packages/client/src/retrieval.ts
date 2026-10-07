import type {
  MediaSearchStatusResponse,
  RelevanceModelStatusResponse,
  RelevanceScoreRequest,
  RetrievalPreviewRequest,
  RetrievalPreviewResponse,
} from '@bendyline/gezel';
import type { ClientJsonRequest } from './office-integrations.js';

/**
 * Retrieval diagnostics and the optional on-device relevance model. Reached as
 * `client.retrieval`. The preview and scoring routes are first-party only;
 * session tokens are refused. See docs/project-retrieval.md and
 * docs/decisions/0017-relevance-model.md.
 */
export class RetrievalClient {
  constructor(private readonly request: ClientJsonRequest) {}

  /**
   * Run a retrieval surface's real decision code without side effects and
   * get back what it would keep, with one decision per candidate.
   */
  previewRetrieval(id: string, body: RetrievalPreviewRequest): Promise<RetrievalPreviewResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/retrieval/preview`, body);
  }

  /** The relevance check: selected model, install state, and the catalog. */
  relevanceModelStatus(): Promise<RelevanceModelStatusResponse> {
    return this.request('GET', '/api/relevance-model');
  }

  /** Download a relevance model in the background; poll `relevanceModelStatus` for progress. */
  installRelevanceModel(
    modelId?: string,
  ): Promise<{ started: boolean; installed?: boolean; reason?: string }> {
    return this.request('POST', '/api/relevance-model/install', modelId ? { modelId } : {});
  }

  /** Media search (photos, video and audio by meaning): model parts, download, ffmpeg. */
  mediaSearchStatus(): Promise<MediaSearchStatusResponse> {
    return this.request('GET', '/api/media-search');
  }

  /**
   * Download the media-search model in the background (`audio` adds the audio
   * encoder video and sound files need); poll `mediaSearchStatus` for progress.
   */
  installMediaSearch(
    opts: { audio?: boolean } = {},
  ): Promise<{ started: boolean; installed?: boolean; reason?: string }> {
    return this.request('POST', '/api/media-search/install', opts.audio ? { audio: true } : {});
  }

  /** Look for ffmpeg again (after the person installs one) and return the fresh status. */
  recheckMediaSearchFfmpeg(): Promise<MediaSearchStatusResponse> {
    return this.request('POST', '/api/media-search/ffmpeg/recheck', {});
  }

  /** Raw relevance-model scores for (query, passage) pairs — the calibration path. */
  scoreRelevance(body: RelevanceScoreRequest): Promise<{
    modelId: string;
    status: string;
    ms: number;
    scores: Array<number | null>;
    relevances: Array<number | null>;
  }> {
    return this.request('POST', '/api/relevance-model/score', body);
  }
}
