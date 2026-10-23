import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildProjectPageTypography } from '../../../../scripts/project-page-typography.mjs';

let stylesheet: string | undefined;

/** The build stages a single shared stylesheet beside the service entry points.
 * Source-mode tests/dev read the same canonical UI assets without a UI build. */
export function projectPageTypographyStyle(): string {
  stylesheet ??= import.meta.url.endsWith('.ts')
    ? buildProjectPageTypography(fileURLToPath(new URL('../../../ui', import.meta.url)))
    : readFileSync(new URL('./page-typography.css', import.meta.url), 'utf8');
  return `<style data-gezel-typography>${stylesheet}</style>`;
}
