/**
 * Stage the legal material for fonts embedded in the published service UI.
 *
 * The service npm tarball carries packages/service/dist/ui, not the UI source
 * tree. Keep the corresponding notices in dist as well so npm consumers get
 * the attribution and license texts without needing the gezel repository.
 */
import { copyFile, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const uiRoot = join(repoRoot, 'packages', 'ui');
const fontsRoot = join(uiRoot, 'src', 'assets', 'fonts');
const serviceDist = join(repoRoot, 'packages', 'service', 'dist');

export const SERVICE_FONT_LEGAL_ROOT = join(serviceDist, 'licenses', 'fonts');
export const SERVICE_NOTICE_PATH = join(serviceDist, 'NOTICE.md');

/** Resolve version-bound license sources from the dependency graph used by Vite. */
export async function serviceFontLegalSources() {
  const files = [];
  for (const name of await readdir(join(fontsRoot, 'licenses'))) {
    if (name.startsWith('LICENSE-') && name.endsWith('.txt')) {
      files.push({ name, source: join(fontsRoot, 'licenses', name) });
    }
  }
  files.push({
    name: 'LICENSE-CC-BY-SA-4.0.txt',
    source: join(fontsRoot, 'LICENSE-CC-BY-SA-4.0.txt'),
  });

  const uiRequire = createRequire(join(uiRoot, 'package.json'));
  const monacoRoot = dirname(uiRequire.resolve('monaco-editor/package.json'));
  files.push(
    {
      name: 'LICENSE-monaco-editor.txt',
      source: join(monacoRoot, 'LICENSE'),
    },
    {
      name: 'THIRD-PARTY-NOTICES-monaco-editor.txt',
      source: join(monacoRoot, 'ThirdPartyNotices.txt'),
    },
  );

  // Font Awesome arrives through squisq-editor-react, so pnpm deliberately
  // does not expose it at packages/ui/node_modules. Resolve from the real
  // direct-dependent package location instead of reaching into .pnpm by name.
  const squisqEditorRoot = await realpath(
    join(uiRoot, 'node_modules', '@bendyline', 'squisq-editor-react'),
  );
  const squisqRequire = createRequire(join(squisqEditorRoot, 'package.json'));
  const fontAwesomeRoot = dirname(
    squisqRequire.resolve('@fortawesome/fontawesome-free/package.json'),
  );
  const fontAwesomePackage = JSON.parse(
    await readFile(join(fontAwesomeRoot, 'package.json'), 'utf8'),
  );
  files.push({
    name: 'LICENSE-font-awesome-free.txt',
    source: join(fontAwesomeRoot, 'LICENSE.txt'),
  });

  files.sort((left, right) => left.name.localeCompare(right.name));
  return { files, fontAwesomeVersion: fontAwesomePackage.version };
}

/** Replace the service's generated font-license bundle with canonical copies. */
export async function stageServiceFontLegalBundle() {
  const { files, fontAwesomeVersion } = await serviceFontLegalSources();
  await rm(SERVICE_FONT_LEGAL_ROOT, { recursive: true, force: true });
  await mkdir(SERVICE_FONT_LEGAL_ROOT, { recursive: true });
  await copyFile(join(repoRoot, 'NOTICE.md'), SERVICE_NOTICE_PATH);
  for (const file of files) {
    await copyFile(file.source, join(SERVICE_FONT_LEGAL_ROOT, file.name));
  }
  return { files: files.length, fontAwesomeVersion };
}

/** Verify generated service legal files are byte-identical to their sources. */
export async function verifyServiceFontLegalBundle() {
  const rootNotice = await readFile(join(repoRoot, 'NOTICE.md'));
  const stagedNotice = await readFile(SERVICE_NOTICE_PATH);
  if (!rootNotice.equals(stagedNotice)) {
    throw new Error('packages/service/dist/NOTICE.md is stale; rebuild @bendyline/gezel-service');
  }

  const { files, fontAwesomeVersion } = await serviceFontLegalSources();
  const expected = files.map((file) => file.name).sort();
  const actual = (await readdir(SERVICE_FONT_LEGAL_ROOT)).sort();
  if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index])) {
    throw new Error(
      `service font-license files differ from canonical sources\n  expected: ${expected.join(', ')}\n  staged: ${actual.join(', ')}`,
    );
  }
  for (const file of files) {
    const [source, staged] = await Promise.all([
      readFile(file.source),
      readFile(join(SERVICE_FONT_LEGAL_ROOT, file.name)),
    ]);
    if (!source.equals(staged)) {
      throw new Error(`service font license is stale: ${basename(file.source)}`);
    }
  }
  return { files: files.length, fontAwesomeVersion };
}
