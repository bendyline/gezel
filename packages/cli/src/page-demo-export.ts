import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type PageDemoConfig, injectPageDemo, pageDemoBootstrapSource } from '@bendyline/gezel';
import { buildProjectPageTypography } from '../../../scripts/project-page-typography.mjs';

export interface DemoFile {
  path: string;
  bytes: Buffer;
}

export function pageDemoAssets(): DemoFile[] {
  const sourceMode = import.meta.url.endsWith('.ts');
  const fonts = fileURLToPath(new URL('../../ui/src/assets/fonts/', import.meta.url));
  const css = sourceMode
    ? buildProjectPageTypography(fileURLToPath(new URL('../../ui', import.meta.url)))
    : readFileSync(new URL('./page-typography.css', import.meta.url), 'utf8');
  const versioned = (stem: string, extension: string, source: string): DemoFile => ({
    path: `${stem}-${createHash('sha256').update(source).digest('hex').slice(0, 16)}.${extension}`,
    bytes: Buffer.from(source),
  });
  return [
    versioned('bootstrap', 'js', pageDemoBootstrapSource()),
    versioned('typography', 'css', css),
    ...['LICENSE-HankenGrotesk-OFL-1.1.txt', 'LICENSE-PTSerif-OFL-1.1.txt'].map((path) => ({
      path,
      bytes: readFileSync(sourceMode ? join(fonts, path) : new URL(`./${path}`, import.meta.url)),
    })),
  ];
}

/** Shared site assets live outside each app's source; offline exports use the same layout. */
export async function writePageDemoAssets(directory: string): Promise<DemoFile[]> {
  const assets = pageDemoAssets();
  await mkdir(directory, { recursive: true });
  for (const asset of assets) await writeFile(join(directory, asset.path), asset.bytes);
  return assets;
}

export async function writePageDemo(
  directory: string,
  files: DemoFile[],
  config: PageDemoConfig,
  shared: { directory: string; assets: DemoFile[] },
): Promise<void> {
  const script = shared.assets.find((file) => file.path.endsWith('.js'))!;
  const style = shared.assets.find((file) => file.path.endsWith('.css'))!;
  for (const file of files) {
    // Callers supply validated catalog/archive paths. Recheck before writing.
    if (
      !file.path ||
      file.path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..') ||
      /[:\\]/.test(file.path)
    ) {
      throw new Error(`Unsafe demo asset path: ${file.path}`);
    }
    const target = join(directory, file.path);
    let bytes = file.bytes;
    if (/\.html?$/i.test(file.path)) {
      const url = (name: string) =>
        relative(dirname(target), join(shared.directory, name))
          .split(/[\\/]/)
          .map((part) => (part === '..' ? part : encodeURIComponent(part)))
          .join('/');
      bytes = Buffer.from(
        injectPageDemo(bytes.toString('utf8'), config, {
          scriptUrl: url(script.path),
          styleUrl: url(style.path),
        }),
      );
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
}
