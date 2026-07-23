import type { LicenseClass } from '@bendyline/gezel';

/**
 * License chip for image/video catalog cards. Replaces the raw license
 * string + separate "Non-commercial" pill with a single button that
 *   - states what the license *means* in plain language (the bucket),
 *   - names it tersely (`licenseShortName`, e.g. "Apache 2.0"), and
 *   - links to the license text/page on HuggingFace (`licenseUrl`).
 *
 * Both `ImageModelManifest` and `VideoModelManifest` carry these license
 * fields; the component takes the structural subset they share rather than
 * either full type (their discriminant `kind` makes an intersection
 * collapse to `never`).
 */
type LicensedManifest = {
  license?: string;
  licenseClass?: LicenseClass;
  licenseShortName?: string;
  licenseUrl?: string;
  upstream?: string;
  // Only image/video manifests carry this; chat + audio models omit it.
  commercialUse?: boolean;
};

/** Plain-language prefix shown before the short license name. */
const CLASS_PREFIX: Record<LicenseClass, string> = {
  open: 'Free, open',
  'commercial-restricted': 'Restrictions for commercial use',
  'custom-restricted': 'Custom restrictions',
};

/** Hover tooltip expanding on what each bucket allows. */
const CLASS_TITLE: Record<LicenseClass, string> = {
  open: 'A permissive open-source license — free to use, modify, and ship, including commercially.',
  'commercial-restricted':
    'Free for personal and research use. The upstream license restricts commercial use.',
  'custom-restricted':
    'Commercial use is allowed but under custom terms — typically use-based or revenue-threshold ' +
    'restrictions. Review the license before relying on it.',
};

/**
 * Resolve the bucket for a manifest. Prefers the explicit `licenseClass`;
 * falls back to the `commercialUse` flag so models that predate the
 * backfill still classify the unambiguous non-commercial case. When even
 * that is absent we return null and the button shows the raw license name.
 */
function resolveClass(m: LicensedManifest): LicenseClass | null {
  if (m.licenseClass) return m.licenseClass;
  if (m.commercialUse === false) return 'commercial-restricted';
  return null;
}

/**
 * ollama.com is the right "learn more" target only on the Ollama tab, where
 * the user is deliberately browsing Ollama-hosted models. Everywhere else —
 * the on-device llama.cpp / MLX pages and the image/video/audio catalogs — a
 * license badge whose only link is an ollama.com model page must not send a
 * local-model user off to ollama.com. So callers opt IN with `allowOllamaLink`
 * and the default is safe: any current or future render site is ollama-free
 * unless it says otherwise.
 */
function isOllamaHost(href: string): boolean {
  try {
    const { hostname } = new URL(href);
    return (
      hostname === 'ollama.com' ||
      hostname.endsWith('.ollama.com') ||
      hostname === 'ollama.ai' ||
      hostname.endsWith('.ollama.ai')
    );
  } catch {
    return false;
  }
}

/**
 * License link target: the explicit URL, else the model card (`upstream`).
 * An ollama.com target is dropped unless `allowOllamaLink` is set, so the
 * badge falls back to a static chip rather than linking off-page.
 */
function licenseHref(m: LicensedManifest, allowOllamaLink: boolean): string | null {
  const href = m.licenseUrl ?? m.upstream ?? null;
  if (href && !allowOllamaLink && isOllamaHost(href)) return null;
  return href;
}

export function LicenseButton({
  manifest,
  allowOllamaLink = false,
}: {
  manifest: LicensedManifest;
  allowOllamaLink?: boolean;
}) {
  const cls = resolveClass(manifest);
  const shortName = manifest.licenseShortName ?? manifest.license;

  // No license metadata at all — nothing useful to show.
  if (!cls && !shortName) return null;

  const label = cls
    ? shortName
      ? `${CLASS_PREFIX[cls]} (${shortName})`
      : CLASS_PREFIX[cls]
    : (shortName as string);
  const title = cls ? CLASS_TITLE[cls] : undefined;
  const className = `license-button license-button--${cls ?? 'unknown'}`;
  const href = licenseHref(manifest, allowOllamaLink);

  // No link target — render a static chip rather than a dead link.
  if (!href) {
    return (
      <span className={className} title={title}>
        {label}
      </span>
    );
  }
  return (
    <a className={className} href={href} target="_blank" rel="noreferrer" title={title}>
      {label}
      <span aria-hidden="true" className="license-button__ext">
        ↗
      </span>
    </a>
  );
}
