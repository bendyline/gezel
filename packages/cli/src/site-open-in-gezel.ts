import { type GezelDeepLink, gezelDeepLinkUrl } from '@bendyline/gezel';

/**
 * "Open in Gezel" on the published site: a `gezel://` link to the same item in
 * the desktop app (docs/deep-links.md). It renders hidden and the script shows
 * it on computers only, since phones have no Gezel desktop app to open. A
 * browser says nothing when no app takes the link, so the script shows a quiet
 * note if the page keeps focus a few seconds after the click.
 */

/** Marks the wrapper; a page links the script only when it carries one. */
export const OPEN_IN_GEZEL_ATTR = 'data-gezel-open';

export function openInGezelHtml(opts: {
  link: GezelDeepLink;
  label: string;
  buttonClass: string;
  noteClass: string;
  downloadHref: string;
}): string {
  return `<span class="open-in-gezel" ${OPEN_IN_GEZEL_ATTR} hidden><a class="${opts.buttonClass}" href="${gezelDeepLinkUrl(opts.link)}">${opts.label}</a><span class="${opts.noteClass}" hidden>Nothing opened? Opening from this site needs the latest Gezel. <a href="${opts.downloadHref}">Get Gezel</a></span></span>`;
}

/** Plain ES5 so it runs as an inline or deferred script on any page. */
export const OPEN_IN_GEZEL_JS = `(function () {
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return;
  var wrappers = document.querySelectorAll('[${OPEN_IN_GEZEL_ATTR}]');
  Array.prototype.forEach.call(wrappers, function (wrapper) {
    var link = wrapper.querySelector('a');
    var note = wrapper.querySelector('span');
    if (!link || !note) return;
    wrapper.hidden = false;
    link.addEventListener('click', function () {
      var timer = setTimeout(function () {
        if (document.hasFocus() && document.visibilityState === 'visible') note.hidden = false;
      }, 2500);
      var left = function () { clearTimeout(timer); };
      window.addEventListener('blur', left, { once: true });
      document.addEventListener('visibilitychange', left, { once: true });
    });
  });
})();
`;
