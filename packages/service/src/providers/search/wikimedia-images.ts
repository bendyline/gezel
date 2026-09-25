import type { WikimediaImageResult } from '@bendyline/gezel';
import { WIKIPEDIA_USER_AGENT } from './wikipedia.js';

interface Page {
  title?: string;
  index?: number;
  imageinfo?: Array<{
    url?: string;
    thumburl?: string;
    descriptionurl?: string;
    width?: number;
    height?: number;
    mime?: string;
    extmetadata?: Record<string, { value?: string }>;
  }>;
}

/** Plain text only: upstream descriptions and attribution are untrusted HTML. */
function plain(value: string | undefined): string {
  return (value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

function mediaUrl(value: string | undefined, host: string | string[]): string | undefined {
  try {
    const url = new URL(value ?? '');
    return url.protocol === 'https:' &&
      (Array.isArray(host) ? host.includes(url.hostname) : url.hostname === host) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** Free Commons file search, including thumbnail and per-file licensing metadata. */
export async function searchWikimediaImages(
  input: { query: string; limit?: number },
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<WikimediaImageResult[]> {
  const url = new URL('https://commons.wikimedia.org/w/api.php');
  const params = {
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrnamespace: '6',
    gsrsearch: input.query,
    gsrlimit: String(Math.min(10, Math.max(1, input.limit ?? 5))),
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
    iiurlwidth: '1024',
    iiextmetadatafilter: 'Artist|Credit|LicenseShortName|LicenseUrl|UsageTerms|ImageDescription',
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetchImpl(url, {
    signal,
    headers: { 'User-Agent': WIKIPEDIA_USER_AGENT, Accept: 'application/json' },
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Wikimedia Commons returned HTTP ${response.status}`);
  const data = (await response.json()) as {
    error?: { info?: string };
    query?: { pages?: Record<string, Page> };
  };
  if (data.error) throw new Error(`Wikimedia Commons: ${plain(data.error.info)}`);
  const results: WikimediaImageResult[] = [];
  const pages = Object.values(data.query?.pages ?? {}).sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  );
  for (const page of pages) {
    const info = page.imageinfo?.[0];
    if (!info || !['image/jpeg', 'image/png', 'image/webp'].includes(info.mime ?? '')) continue;
    const imageUrl = mediaUrl(info.thumburl ?? info.url, [
      'upload.wikimedia.org',
      'thumb.wikimedia.org',
    ]);
    const sourceUrl = mediaUrl(info.descriptionurl, 'commons.wikimedia.org');
    if (!imageUrl || !sourceUrl || !page.title) continue;
    const m = info.extmetadata ?? {};
    results.push({
      title: plain(page.title),
      imageUrl,
      sourceUrl,
      width: info.width ?? 0,
      height: info.height ?? 0,
      description: plain(m.ImageDescription?.value),
      credit: plain(m.Artist?.value) || plain(m.Credit?.value) || 'See source page',
      license: plain(m.LicenseShortName?.value) || 'Unknown — check source page',
      licenseUrl: plain(m.LicenseUrl?.value),
      usageTerms: plain(m.UsageTerms?.value),
    });
  }
  return results.slice(0, input.limit ?? 5);
}
