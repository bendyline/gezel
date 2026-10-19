import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Build from the shell's canonical fonts. Data URLs also work inside opaque,
 * offline page sandboxes without an authenticated asset URL or network access. */
export function buildProjectPageTypography(uiRoot) {
  const fonts = join(uiRoot, 'src/assets/fonts');
  const faces = readFileSync(join(fonts, 'ui-fonts.css'), 'utf8').replace(
    /url\("\.\/([a-z0-9-]+\.woff2)"\)/g,
    (_, name) =>
      `url("data:font/woff2;base64,${readFileSync(join(fonts, name)).toString('base64')}")`,
  );
  return [
    faces,
    readFileSync(join(fonts, 'typography-tokens.css'), 'utf8'),
    readFileSync(join(fonts, 'page-defaults.css'), 'utf8'),
  ].join('\n');
}

/** Build-time only. Mobile ships the same stylesheet as the service. */
export function projectPageTypographyPlugin(uiRoot) {
  const id = 'virtual:gezel-page-typography';
  return {
    name: 'gezel-page-typography',
    resolveId(source) {
      return source === id ? `\0${id}` : null;
    },
    load(source) {
      if (source !== `\0${id}`) return null;
      return `export default ${JSON.stringify(buildProjectPageTypography(uiRoot))};`;
    },
  };
}
