/**
 * A fake YouTube Data API v3 for the `youtube-videos` connector: channels
 * with uploads playlists, `channels.list` (by id, `forHandle`,
 * `forUsername`), `playlistItems.list` with opaque page tokens, and
 * `videos.list` by id — each answering with the resource shapes, parts
 * filtering, quota cost (one unit per call) and error bodies of the real
 * API, including the API-key failures Google returns from its front end
 * rather than from YouTube itself.
 *
 * Shapes follow https://developers.google.com/youtube/v3/docs (channels,
 * playlistItems, videos) and the error body Google APIs use:
 * `{ error: { code, message, errors: [{ message, domain, reason }], status?, details? } }`.
 */

import { type FakeHttp, type FakeRequest, json } from './fake-http.js';

export const FAKE_YOUTUBE_KEY = 'AIzaSyFAKE-test-key-0123456789abcdef';
const API = 'https://www.googleapis.com/youtube/v3';

export interface FakeVideo {
  id: string;
  title: string;
  description?: string;
  /** ISO 8601. */
  publishedAt: string;
  tags?: string[];
  /** ISO 8601 duration. */
  duration?: string;
  views?: number;
  /** Undefined = the owner hid likes. */
  likes?: number;
  /** Undefined = comments disabled. */
  comments?: number;
  privacy?: 'public' | 'unlisted' | 'private';
  live?: 'none' | 'live' | 'upcoming';
  captions?: boolean;
  language?: string;
}

export interface FakeChannel {
  id: string;
  handle?: string;
  username?: string;
  title: string;
  /** Newest first, the order of an uploads playlist. */
  videos: FakeVideo[];
}

function googleError(
  code: number,
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return json(
    {
      error: {
        code,
        message,
        errors: [
          { message, domain: reason === 'quotaExceeded' ? 'youtube.quota' : 'global', reason },
        ],
        ...extra,
      },
    },
    { status: code },
  );
}

/** The 403 Google answers once the project's daily quota is spent. */
export function quotaExceeded(): Response {
  return googleError(
    403,
    'quotaExceeded',
    'The request cannot be completed because you have exceeded your <a href="/youtube/v3/getting-started#quota">quota</a>.',
  );
}

/** The 400 Google's front end answers for a key that does not exist. */
export function apiKeyInvalid(): Response {
  return googleError(400, 'badRequest', 'API key not valid. Please pass a valid API key.', {
    status: 'INVALID_ARGUMENT',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'API_KEY_INVALID',
        domain: 'googleapis.com',
        metadata: { service: 'youtube.googleapis.com' },
      },
    ],
  });
}

const THUMBNAILS = [
  ['default', 'default', 120, 90],
  ['medium', 'mqdefault', 320, 180],
  ['high', 'hqdefault', 480, 360],
  ['standard', 'sddefault', 640, 480],
  ['maxres', 'maxresdefault', 1280, 720],
] as const;

const tokenOf = (offset: number) => Buffer.from(`offset:${offset}`).toString('base64url');
function offsetOf(token: string): number | null {
  const m = /^offset:(\d+)$/.exec(Buffer.from(token, 'base64url').toString('utf8'));
  return m ? Number(m[1]) : null;
}

export class FakeYouTube {
  readonly channels: FakeChannel[] = [];
  /** Every API call: resource, query, and the quota it cost. */
  readonly calls: { resource: string; query: URLSearchParams; units: number }[] = [];
  quotaUsed = 0;
  private validKeys = new Set([FAKE_YOUTUBE_KEY]);
  private anyKey: boolean;
  private apiDisabled = false;

  /**
   * `acceptAnyKey` lets the provider simulator bind with a placeholder
   * credential; tests keep the default so a wrong key is caught.
   */
  constructor(opts: { acceptAnyKey?: boolean } = {}) {
    this.anyKey = opts.acceptAnyKey === true;
  }

  channel(init: FakeChannel): this {
    this.channels.push({ ...init, videos: [...init.videos] });
    return this;
  }

  /** A new upload lands at the top of the channel's uploads playlist. */
  upload(channelId: string, video: FakeVideo): this {
    this.find(channelId).videos.unshift(video);
    return this;
  }

  updateVideo(videoId: string, patch: Partial<FakeVideo>): this {
    for (const c of this.channels) {
      const v = c.videos.find((x) => x.id === videoId);
      if (v) {
        Object.assign(v, patch);
        return this;
      }
    }
    throw new Error(`no fake video ${videoId}`);
  }

  deleteVideo(videoId: string): this {
    for (const c of this.channels) c.videos = c.videos.filter((v) => v.id !== videoId);
    return this;
  }

  /** Revoke every key (deleted in the Cloud console). */
  revokeKeys(): this {
    this.validKeys.clear();
    this.anyKey = false;
    return this;
  }

  /** The key's project has the YouTube Data API disabled. */
  disableApi(): this {
    this.apiDisabled = true;
    return this;
  }

  uploadsPlaylistId(channelId: string): string {
    return `UU${channelId.slice(2)}`;
  }

  install(http: FakeHttp): this {
    http.on('GET', `${API}/channels`, (req) =>
      this.guard(req, 'channels', () => this.channelsList(req)),
    );
    http.on('GET', `${API}/playlistItems`, (req) =>
      this.guard(req, 'playlistItems', () => this.playlistItemsList(req)),
    );
    http.on('GET', `${API}/videos`, (req) => this.guard(req, 'videos', () => this.videosList(req)));
    return this;
  }

  private find(channelId: string): FakeChannel {
    const c = this.channels.find((x) => x.id === channelId);
    if (!c) throw new Error(`no fake channel ${channelId}`);
    return c;
  }

  private guard(req: FakeRequest, resource: string, answer: () => Response): Response {
    const key = req.headers.get('x-goog-api-key') ?? req.url.searchParams.get('key');
    if (!key) {
      return googleError(403, 'forbidden', 'The request is missing a valid API key.', {
        status: 'PERMISSION_DENIED',
      });
    }
    if (!this.anyKey && !this.validKeys.has(key)) return apiKeyInvalid();
    if (this.apiDisabled) {
      return googleError(
        403,
        'accessNotConfigured',
        'YouTube Data API v3 has not been used in project 123456789 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/youtube.googleapis.com/overview?project=123456789 then retry.',
        { status: 'PERMISSION_DENIED' },
      );
    }
    if (!req.url.searchParams.get('part')) {
      return googleError(400, 'required', 'Required parameter: part');
    }
    this.calls.push({ resource, query: req.url.searchParams, units: 1 });
    this.quotaUsed += 1;
    return answer();
  }

  private parts(req: FakeRequest): Set<string> {
    return new Set((req.url.searchParams.get('part') ?? '').split(',').map((p) => p.trim()));
  }

  private channelsList(req: FakeRequest): Response {
    const q = req.url.searchParams;
    const filters = ['id', 'forHandle', 'forUsername', 'mine'].filter((f) => q.has(f));
    if (filters.length !== 1) {
      return googleError(400, 'invalidCriteria', 'Exactly one filter must be specified.');
    }
    let found: FakeChannel[] = [];
    if (q.has('id')) {
      const ids = (q.get('id') ?? '').split(',');
      found = this.channels.filter((c) => ids.includes(c.id));
    } else if (q.has('forHandle')) {
      const handle = (q.get('forHandle') ?? '').replace(/^@/, '').toLowerCase();
      found = this.channels.filter((c) => c.handle?.replace(/^@/, '').toLowerCase() === handle);
    } else if (q.has('forUsername')) {
      found = this.channels.filter((c) => c.username === q.get('forUsername'));
    }
    const parts = this.parts(req);
    // An unmatched filter is a 200 with no `items` key, not a 404.
    return json({
      kind: 'youtube#channelListResponse',
      etag: 'etag-channels',
      pageInfo: { totalResults: found.length, resultsPerPage: 5 },
      ...(found.length
        ? {
            items: found.map((c) => ({
              kind: 'youtube#channel',
              etag: `etag-${c.id}`,
              id: c.id,
              ...(parts.has('snippet')
                ? {
                    snippet: {
                      title: c.title,
                      description: '',
                      ...(c.handle ? { customUrl: c.handle.toLowerCase() } : {}),
                      publishedAt: '2019-03-02T10:11:12Z',
                    },
                  }
                : {}),
              ...(parts.has('contentDetails')
                ? {
                    contentDetails: {
                      relatedPlaylists: { likes: '', uploads: this.uploadsPlaylistId(c.id) },
                    },
                  }
                : {}),
            })),
          }
        : {}),
    });
  }

  private playlistItemsList(req: FakeRequest): Response {
    const q = req.url.searchParams;
    const playlistId = q.get('playlistId');
    if (!playlistId) {
      return googleError(400, 'playlistIdRequired', 'No playlistId was specified.');
    }
    const channel = this.channels.find((c) => this.uploadsPlaylistId(c.id) === playlistId);
    if (!channel) {
      return googleError(
        404,
        'playlistNotFound',
        "The playlist identified with the request's <code>playlistId</code> parameter cannot be found.",
      );
    }
    const max = Number(q.get('maxResults') ?? '5');
    if (!Number.isInteger(max) || max < 0 || max > 50) {
      return googleError(
        400,
        'invalidValue',
        `Invalid value '${q.get('maxResults')}'. Values must be within the range: [0, 50]`,
      );
    }
    let offset = 0;
    const token = q.get('pageToken');
    if (token) {
      const parsed = offsetOf(token);
      if (parsed === null)
        return googleError(400, 'invalidPageToken', 'The request specifies an invalid page token.');
      offset = parsed;
    }
    // API-key callers never see a channel's private uploads.
    const visible = channel.videos.filter((v) => v.privacy !== 'private');
    const slice = visible.slice(offset, offset + max);
    const next = offset + slice.length;
    const parts = this.parts(req);
    return json({
      kind: 'youtube#playlistItemListResponse',
      etag: `etag-${playlistId}-${offset}`,
      ...(next < visible.length ? { nextPageToken: tokenOf(next) } : {}),
      ...(offset > 0 ? { prevPageToken: tokenOf(Math.max(0, offset - max)) } : {}),
      items: slice.map((v, i) => ({
        kind: 'youtube#playlistItem',
        etag: `etag-item-${v.id}`,
        id: Buffer.from(`${playlistId}.${v.id}`).toString('base64url'),
        ...(parts.has('snippet')
          ? {
              snippet: {
                publishedAt: v.publishedAt,
                channelId: channel.id,
                title: v.title,
                description: v.description ?? '',
                channelTitle: channel.title,
                playlistId,
                position: offset + i,
                resourceId: { kind: 'youtube#video', videoId: v.id },
                videoOwnerChannelTitle: channel.title,
                videoOwnerChannelId: channel.id,
              },
            }
          : {}),
        ...(parts.has('contentDetails')
          ? { contentDetails: { videoId: v.id, videoPublishedAt: v.publishedAt } }
          : {}),
        ...(parts.has('status') ? { status: { privacyStatus: v.privacy ?? 'public' } } : {}),
      })),
      pageInfo: { totalResults: visible.length, resultsPerPage: max },
    });
  }

  private videosList(req: FakeRequest): Response {
    const q = req.url.searchParams;
    const ids = (q.get('id') ?? '').split(',').filter(Boolean);
    if (ids.length === 0) {
      return googleError(
        400,
        'missingRequiredParameter',
        'No filter selected. Expected one of: id, chart, myRating',
      );
    }
    if (ids.length > 50) {
      return googleError(400, 'invalidFilters', 'The request specifies more than 50 video ids.');
    }
    const parts = this.parts(req);
    const items = [];
    for (const id of ids) {
      for (const c of this.channels) {
        const v = c.videos.find((x) => x.id === id);
        if (!v || v.privacy === 'private') continue;
        const thumbs = Object.fromEntries(
          THUMBNAILS.map(([size, file, width, height]) => [
            size,
            { url: `https://i.ytimg.com/vi/${v.id}/${file}.jpg`, width, height },
          ]),
        );
        items.push({
          kind: 'youtube#video',
          etag: `etag-video-${v.id}`,
          id: v.id,
          ...(parts.has('snippet')
            ? {
                snippet: {
                  publishedAt: v.publishedAt,
                  channelId: c.id,
                  title: v.title,
                  description: v.description ?? '',
                  thumbnails: thumbs,
                  channelTitle: c.title,
                  ...(v.tags ? { tags: v.tags } : {}),
                  categoryId: '22',
                  liveBroadcastContent: v.live ?? 'none',
                  ...(v.language ? { defaultAudioLanguage: v.language } : {}),
                  localized: { title: v.title, description: v.description ?? '' },
                },
              }
            : {}),
          ...(parts.has('contentDetails')
            ? {
                contentDetails: {
                  duration: v.duration ?? 'PT4M13S',
                  dimension: '2d',
                  definition: 'hd',
                  caption: v.captions ? 'true' : 'false',
                  licensedContent: false,
                  contentRating: {},
                  projection: 'rectangular',
                },
              }
            : {}),
          ...(parts.has('statistics')
            ? {
                statistics: {
                  viewCount: String(v.views ?? 0),
                  ...(v.likes !== undefined ? { likeCount: String(v.likes) } : {}),
                  favoriteCount: '0',
                  ...(v.comments !== undefined ? { commentCount: String(v.comments) } : {}),
                },
              }
            : {}),
          ...(parts.has('status')
            ? {
                status: {
                  uploadStatus: 'processed',
                  privacyStatus: v.privacy ?? 'public',
                  license: 'youtube',
                  embeddable: true,
                  publicStatsViewable: true,
                  madeForKids: false,
                },
              }
            : {}),
        });
      }
    }
    return json({
      kind: 'youtube#videoListResponse',
      etag: 'etag-videos',
      items,
      pageInfo: { totalResults: items.length, resultsPerPage: items.length },
    });
  }
}
