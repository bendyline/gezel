import { type ReactNode, useState } from 'react';

/**
 * Renders catalog artwork without ever exposing the browser's native
 * broken-image placeholder. Callers provide the glyph/initial fallback that
 * belongs to their surface.
 *
 * `iconSvg` is intended for catalog SVG that has already been sanitized by
 * the service before it reaches the UI.
 */
export function CatalogArtwork({
  iconSvg,
  logoUrl,
  svgClassName,
  imageClassName,
  fallback,
}: {
  iconSvg?: string;
  logoUrl?: string;
  svgClassName?: string;
  imageClassName?: string;
  fallback: ReactNode;
}) {
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null);
  const [loadedLogoUrl, setLoadedLogoUrl] = useState<string | null>(null);

  if (iconSvg) {
    return (
      <span
        className={svgClassName}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: catalog SVGs are sanitized before delivery.
        dangerouslySetInnerHTML={{ __html: iconSvg }}
      />
    );
  }

  if (logoUrl && failedLogoUrl !== logoUrl) {
    return (
      <>
        {loadedLogoUrl !== logoUrl && fallback}
        <img
          className={imageClassName}
          src={logoUrl}
          alt=""
          hidden={loadedLogoUrl !== logoUrl}
          onLoad={() => setLoadedLogoUrl(logoUrl)}
          onError={() => setFailedLogoUrl(logoUrl)}
        />
      </>
    );
  }

  return fallback;
}
