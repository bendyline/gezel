/**
 * A small fake website for the website connector's tests and the connector
 * simulator: pages with titles, text and links, served over `FakeHttp`, that
 * a test can edit, remove, wall off or slow down between passes. Pages are
 * served as ordinary server-rendered HTML with a header, navigation and
 * footer around a `<main>`, so the text-only extractor has real work to do.
 */

import { FakeHttp } from './fake-http.js';

export interface FakePage {
  title: string;
  /** Paragraphs of the page's main text. */
  text: string[];
  /** Paths or absolute addresses linked from the page's main text. */
  links?: string[];
  description?: string;
  status?: number;
  /** Serve a bot check instead of the page. */
  challenge?: boolean;
  /** Serve a sign-in form instead of the page. */
  signInWall?: boolean;
  /** Answer 307 to this path instead of the page. */
  redirectTo?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class FakeSite {
  readonly http: FakeHttp;
  private readonly pages = new Map<string, FakePage>();
  robots: string | null = null;
  /** Paths served, in order. */
  readonly served: string[] = [];

  constructor(
    readonly origin = 'https://site.test',
    http?: FakeHttp,
  ) {
    this.http = http ?? new FakeHttp();
    this.http.on('GET', `${origin}/*`, (req) => this.serve(req.url));
  }

  set(path: string, page: FakePage): this {
    this.pages.set(path, page);
    return this;
  }

  get(path: string): FakePage | undefined {
    return this.pages.get(path);
  }

  /** The page now answers 404. */
  remove(path: string): this {
    this.pages.delete(path);
    return this;
  }

  url(path: string): string {
    return new URL(path, this.origin).href;
  }

  html(path: string): string | null {
    const page = this.pages.get(path);
    if (!page) return null;
    if (page.challenge) {
      return '<!doctype html><html><head><title>Just a moment...</title></head><body><p>Checking your browser before accessing the site.</p></body></html>';
    }
    if (page.signInWall) {
      return '<!doctype html><html><head><title>Sign in</title></head><body><main><form><input type="password" name="pw"></form></main></body></html>';
    }
    const links = (page.links ?? [])
      .map(
        (l) =>
          `<li><a href="${escapeHtml(l)}">${escapeHtml(this.pages.get(l)?.title ?? l)}</a></li>`,
      )
      .join('');
    return `<!doctype html>
<html lang="en">
<head>
<title>${escapeHtml(page.title)}</title>
<meta name="description" content="${escapeHtml(page.description ?? `About ${page.title}`)}">
</head>
<body>
<header><nav><a href="/">Home</a></nav></header>
<main>
<h1>${escapeHtml(page.title)}</h1>
${page.text.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')}
${links ? `<ul>${links}</ul>` : ''}
</main>
<footer>Copyright Fake Site</footer>
</body>
</html>`;
  }

  private serve(url: URL): Response {
    this.served.push(url.pathname);
    if (url.pathname === '/robots.txt') {
      return this.robots === null
        ? new Response('not found', { status: 404 })
        : new Response(this.robots, { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    const page = this.pages.get(url.pathname);
    if (!page)
      return new Response('<h1>Not found</h1>', {
        status: 404,
        headers: { 'content-type': 'text/html' },
      });
    if (page.redirectTo) {
      return new Response(null, {
        status: 307,
        headers: { location: new URL(page.redirectTo, this.origin).href },
      });
    }
    const status = page.status ?? 200;
    return new Response(this.html(url.pathname), {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
}
