/**
 * Scripts the capture worker runs inside a page, in an isolated JavaScript
 * world (CDP `Page.createIsolatedWorld`): the DOM is the page's, but these
 * built-ins are not, so page script cannot tamper with what is read. They
 * are plain JavaScript strings rather than TypeScript functions on purpose:
 * the bundler is free to rewrite a function (helpers, renamed bindings) in
 * ways that break once it is serialized into another realm.
 *
 * None of them send input. Scrolling and opening `<details>` are property
 * writes; overlays are hidden by style, never dismissed by a click.
 */

/** Scroll by script so lazy content loads, open closed `<details>`, return to the top. */
export const PREPARE_SCRIPT = `(async () => {
  const max = Math.min(document.documentElement ? document.documentElement.scrollHeight : 0, 24000);
  for (let y = 0; y < max; y += 800) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 120));
  }
  for (const d of document.querySelectorAll('details:not([open])')) d.open = true;
  window.scrollTo(0, 0);
  return true;
})()`;

/**
 * Hide what covers the page: consent and cookie banners, sign-up modals and
 * full-screen overlays, and re-enable scrolling a modal turned off. Returns
 * how many were hidden.
 */
export const HIDE_OVERLAYS_SCRIPT = `(() => {
  const vw = innerWidth, vh = innerHeight;
  let hidden = 0;
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const area = w * h;
    if (area <= 0) continue;
    const text = (el.innerText || '').slice(0, 2000);
    const consent = /cookie|consent|gdpr|privacy|accept all|we value your|your choices/i.test(text);
    const modal = el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true';
    const covering = cs.position === 'fixed' && area > 0.5 * vw * vh;
    if ((consent && area > 0.04 * vw * vh) || (modal && area > 0.2 * vw * vh) || covering) {
      el.style.setProperty('display', 'none', 'important');
      hidden++;
    }
  }
  for (const el of [document.documentElement, document.body]) {
    if (el && getComputedStyle(el).overflow === 'hidden') el.style.setProperty('overflow', 'auto', 'important');
  }
  return hidden;
})()`;

/**
 * Read the page. Requires \`Readability\` defined in this world. Keeps the
 * chosen main content in the isolated world for \`FINALIZE_SCRIPT\`, and
 * returns metadata, visible links, the main content's images and the signals
 * the worker uses to recognize a bot check or a sign-in wall.
 */
export const EXTRACT_SCRIPT = `((opts) => {
  const MAX_LINKS = opts.maxLinks || 600;
  const view = document.defaultView;

  function invisible(el) {
    if (el.hidden) return true;
    const cs = view.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
    if (Number(cs.opacity) === 0) return true;
    if (parseFloat(cs.fontSize) === 0 && el.children.length === 0) return true;
    const clip = cs.clipPath || '';
    if (/inset\\(\\s*(50%|100%)/.test(clip) || cs.clip === 'rect(0px, 0px, 0px, 0px)') return true;
    if (cs.position === 'absolute' || cs.position === 'fixed') {
      const r = el.getBoundingClientRect();
      if (r.right < -1000 || r.bottom < -1000 || r.left > 100000) return true;
      if ((r.width <= 1 || r.height <= 1) && cs.overflow === 'hidden') return true;
    }
    return false;
  }

  // Judge visibility on the live tree, apply it to a clone (same shape, so
  // children pair by index). Hidden text is the usual carrier of injection.
  const clone = document.cloneNode(true);
  const drop = [];
  let hiddenCount = 0;
  const stack = document.body && clone.body ? [[document.body, clone.body]] : [];
  let visited = 0;
  while (stack.length > 0 && visited < 60000) {
    const pair = stack.pop();
    const liveKids = pair[0].children;
    const copyKids = pair[1].children;
    for (let i = 0; i < liveKids.length && i < copyKids.length; i++) {
      visited++;
      if (invisible(liveKids[i])) { drop.push(copyKids[i]); hiddenCount++; }
      else stack.push([liveKids[i], copyKids[i]]);
    }
  }
  for (const el of drop) el.remove();
  // Controls go; a <form> itself stays, since some sites wrap the whole page in one.
  for (const el of clone.querySelectorAll('script,style,noscript,template,iframe,object,embed,canvas,button,input,select,textarea,dialog')) el.remove();

  const meta = (sel) => {
    const v = document.querySelector(sel);
    const c = v && v.getAttribute('content');
    return c && c.trim() ? c.trim().slice(0, 1000) : undefined;
  };
  const jsonLd = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { jsonLd.push(JSON.parse(s.textContent || '')); } catch (e) {}
    if (jsonLd.length >= 5) break;
  }
  const flat = [];
  for (const v of jsonLd) {
    if (Array.isArray(v)) flat.push(...v);
    else if (v && Array.isArray(v['@graph'])) flat.push(...v['@graph']);
    else flat.push(v);
  }
  const ld = (k) => {
    for (const v of flat) if (v && typeof v[k] === 'string') return v[k].slice(0, 300);
    return undefined;
  };
  const canonicalEl = document.querySelector('link[rel="canonical"]');
  const metadata = {
    title: (meta('meta[property="og:title"]') || document.title || '').trim().slice(0, 300),
    description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
    siteName: meta('meta[property="og:site_name"]'),
    lang: document.documentElement.lang || undefined,
    canonical: canonicalEl ? canonicalEl.href : undefined,
    published: meta('meta[property="article:published_time"]') || ld('datePublished'),
    modified: meta('meta[property="article:modified_time"]') || ld('dateModified'),
    author: meta('meta[name="author"]'),
    type: ld('@type') || meta('meta[property="og:type"]'),
  };

  const textOf = (node) => ((node && node.textContent) || '').replace(/\\s+/g, ' ').trim();
  const visibleText = textOf(clone.body);

  let main = null;
  let method = 'none';
  let readabilityChars = 0;
  try {
    const r = new Readability(clone.cloneNode(true), { charThreshold: 300, keepClasses: false }).parse();
    if (r && r.content) {
      const holder = clone.createElement('div');
      holder.innerHTML = r.content;
      main = holder;
      readabilityChars = textOf(holder).length;
    }
  } catch (e) { main = null; }

  // Readability is built for articles. On an index, a docs landing page or a
  // forum it keeps one card and drops the rest; fall back to the page's own
  // landmarks when it kept too little of what a visitor sees.
  const landmark = clone.querySelector('main, [role="main"]') ||
    (clone.querySelectorAll('article').length === 1 ? clone.querySelector('article') : null);
  let fallback = null;
  if (landmark) {
    fallback = clone.createElement('div');
    fallback.innerHTML = landmark.innerHTML;
    // Many sites put their menus inside <main>. Links are collected from the
    // whole page below, so dropping them here costs nothing in discovery.
    for (const el of fallback.querySelectorAll('nav, [role="navigation"], [role="banner"], [role="contentinfo"]')) el.remove();
    for (const el of fallback.querySelectorAll('aside')) {
      const all = textOf(el).length;
      let linked = 0;
      for (const a of el.querySelectorAll('a')) linked += textOf(a).length;
      if (all > 0 && linked / all > 0.6) el.remove();
    }
  } else if (clone.body) {
    fallback = clone.body.cloneNode(true);
    for (const el of fallback.querySelectorAll('header, footer, nav, aside, [role="banner"], [role="navigation"], [role="contentinfo"]')) el.remove();
  }
  const fallbackChars = fallback ? textOf(fallback).length : 0;
  if (main && readabilityChars >= 400 && readabilityChars >= 0.35 * Math.min(fallbackChars || visibleText.length, visibleText.length)) {
    method = 'readability';
  } else if (fallback && fallbackChars > 0) {
    main = fallback;
    method = landmark ? 'landmark' : 'body';
  }

  const abs = (raw) => {
    try { return new URL(raw, document.baseURI).href; } catch (e) { return null; }
  };
  const images = [];
  if (main) {
    for (const a of main.querySelectorAll('a[href]')) {
      const raw = a.getAttribute('href') || '';
      const href = abs(raw);
      if (!href || raw.startsWith('#') || !/^https?:/.test(href)) {
        a.replaceWith(clone.createTextNode(a.textContent || ''));
      } else {
        a.setAttribute('href', href);
      }
    }
    let n = 0;
    for (const img of main.querySelectorAll('img')) {
      const src = abs(img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || '');
      if (!src || !/^https?:/.test(src)) { img.remove(); continue; }
      const key = 'img-' + (n++);
      img.setAttribute('data-gezel-key', key);
      img.setAttribute('src', src);
      img.removeAttribute('srcset');
      if (images.length < 40) images.push({ key, src, alt: (img.getAttribute('alt') || '').slice(0, 300) });
    }
  }
  globalThis.__gezelMain = main;
  globalThis.__gezelDoc = clone;

  const links = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    if (links.length >= MAX_LINKS) break;
    const href = abs(a.getAttribute('href') || '');
    if (!href || !/^https?:/.test(href)) continue;
    const text = (a.innerText || a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160);
    const key = href + '\\u0000' + text;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ href, text });
  }

  const mainText = main ? textOf(main) : '';
  let passwordField = false;
  for (const input of document.querySelectorAll('input[type="password"]')) {
    if (!invisible(input)) { passwordField = true; break; }
  }
  const words = mainText.split(' ').filter(Boolean);
  const mid = Math.floor(words.length / 2);
  return {
    url: location.href,
    metadata,
    method,
    hiddenElements: hiddenCount,
    images,
    links,
    mainChars: mainText.length,
    visibleChars: visibleText.length,
    passwordField,
    textSample: words.slice(mid, mid + 6).join(' '),
  };
})`;

/**
 * Finish the main content: point each saved image at its attachment, turn
 * each image that was not saved into a captioned link (an offline record
 * must never load from the internet), and return the HTML.
 */
export const FINALIZE_SCRIPT = `((saved) => {
  const main = globalThis.__gezelMain;
  const doc = globalThis.__gezelDoc;
  if (!main || !doc) return '';
  for (const img of main.querySelectorAll('img[data-gezel-key]')) {
    const key = img.getAttribute('data-gezel-key');
    const name = saved[key];
    if (name) {
      img.setAttribute('src', 'attachment:' + name);
      img.removeAttribute('data-gezel-key');
    } else {
      const alt = (img.getAttribute('alt') || '').trim();
      const a = doc.createElement('a');
      a.setAttribute('href', img.getAttribute('src') || '');
      a.textContent = alt ? 'Image: ' + alt : 'Image';
      img.replaceWith(a);
    }
  }
  return main.innerHTML;
})`;
