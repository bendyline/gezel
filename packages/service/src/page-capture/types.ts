/**
 * Page capture: how the daemon turns one web address into an offline copy a
 * gezel can read and a person can look at. The website connector is the only
 * caller. No model is anywhere in this path: the browser is driven by fixed
 * daemon code, toward addresses a person approved, and it never clicks, types
 * or submits. Contract: docs/website-connector.md.
 */

import type { SiteScope } from '@bendyline/gezel';

/** Options for one capture session (one sync pass of one binding). */
export interface CaptureSessionOptions {
  /**
   * Hosts the person typed whose private (intranet) addresses this session
   * may reach, and only while a page on that same host is being captured.
   * Everything else private (loopback, the LAN, link-local, cloud metadata)
   * is refused at the proxy.
   */
  privateHosts: readonly string[];
  /** Render in a real browser when one is available; false forces text-only. */
  browser: boolean;
  /**
   * Allow page scripts to send POST requests (many sites load their content
   * that way). Anonymous sessions allow it; signed-in sessions do not unless
   * the person allowed it for the binding, since a POST can change things.
   */
  allowScriptPost: boolean;
  /** Signed-in browser state (cookies + local storage), applied before the first page. */
  storageState?: StorageStateLike;
  /** Stops the session now: every capture in flight fails and the browser closes. */
  signal?: AbortSignal;
}

/** Playwright's storage-state shape, opaque to everything but the worker. */
export interface StorageStateLike {
  cookies: unknown[];
  origins: unknown[];
}

/** One page to capture inside a session. */
export interface PageCaptureRequest {
  url: string;
  /** Screenshots to take: the first screen, then tiles further down. 0..6. */
  screenshots: number;
  /** Content images inside the main text to keep, at most. */
  maxImages: number;
  /** Folder the session writes screenshot and image files into. */
  stagingDir: string;
  /** Validators from the last capture: a text-only session sends a conditional GET. */
  etag?: string;
  lastModified?: string;
  /**
   * Site scopes the page must stay inside. A capture redirected out of them
   * is refused as `left-scope` rather than saved under the wrong address, and
   * the browser aborts any later navigation of the main frame. Absent means
   * the page's own site (a page saved on its own).
   */
  scopes?: SiteScope[];
}

/** A file the session wrote into the staging folder. */
export interface CapturedFile {
  /** Absolute path inside the request's staging folder. */
  path: string;
  /** Name for the record's attachment (`view-1.jpg`). */
  name: string;
  sha256: string;
  size: number;
}

export interface PageMetadata {
  title: string;
  description?: string;
  siteName?: string;
  lang?: string;
  canonical?: string;
  published?: string;
  modified?: string;
  author?: string;
  /** Schema.org or Open Graph type (`Article`, `Product`, `website`). */
  type?: string;
}

export interface FoundLink {
  href: string;
  text: string;
}

/** A page that was captured. */
export interface CapturedPage {
  ok: true;
  /** The address the page ended up at, after redirects. */
  finalUrl: string;
  status: number;
  render: 'browser' | 'http';
  metadata: PageMetadata;
  /** Main content as markdown; absolute links; remote images as captioned links. */
  markdown: string;
  /** How the main content was chosen. */
  method: 'readability' | 'landmark' | 'body' | 'text';
  words: number;
  /** Visible links on the page, absolute, deduplicated. */
  links: FoundLink[];
  screenshots: CapturedFile[];
  /** Content images saved from the main text, with their alt text. */
  images: (CapturedFile & { alt: string; src: string })[];
  /** Elements dropped because a visitor could not see them. */
  hiddenElements: number;
  /** A visible password field on the page (a sign-in form). */
  passwordField?: boolean;
  /** Validators for the next conditional request. */
  etag?: string;
  lastModified?: string;
  /** The page's text was already in the HTML the server sent (no script needed). */
  staticText?: boolean;
}

/** Why a page was not captured. */
export type CaptureFailureKind =
  /** 304: unchanged since the validators the request carried. */
  | 'not-modified'
  /** 404 or 410. */
  | 'gone'
  /** A bot check, a sign-in wall, 401/403, or a consent wall with no content. */
  | 'blocked'
  /** 429 or 503: the site asked us to slow down. */
  | 'rate-limited'
  /** Redirected outside the site's scope. */
  | 'left-scope'
  /** Not an HTML page (a download, an image, a PDF). */
  | 'not-a-page'
  /** Network, timeout, crash, or anything else; retried later. */
  | 'failed'
  /** No capture is possible at all right now (browser missing, policy off, stopped). */
  | 'unavailable';

export interface CaptureFailure {
  ok: false;
  kind: CaptureFailureKind;
  /** Plain-language reason a person can read. */
  message: string;
  status?: number;
  /** The address it ended up at, when it got that far. */
  finalUrl?: string;
  /** Seconds the site asked us to wait (`Retry-After`). */
  retryAfterSec?: number;
}

export type PageCaptureOutcome = CapturedPage | CaptureFailure;

/** One pass's worth of captures, sharing one browser. */
export interface CaptureSession {
  /** How this session renders. `http` when no browser is available or none was asked for. */
  readonly render: 'browser' | 'http';
  /** Why the browser is not in use, when `render` is `http` and a browser was asked for. */
  readonly browserUnavailableReason?: string;
  capture(req: PageCaptureRequest): Promise<PageCaptureOutcome>;
  /** The session's current signed-in state, for re-saving rotated cookies. */
  storageState?(): Promise<StorageStateLike | undefined>;
  close(): Promise<void>;
}

/** The daemon's capture service, as the website adapter sees it. */
export interface PageCapturer {
  open(opts: CaptureSessionOptions): Promise<CaptureSession>;
}

/** Thrown by `open` when nothing can be captured right now. */
export class CaptureUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptureUnavailableError';
  }
}
