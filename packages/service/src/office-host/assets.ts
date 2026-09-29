import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the Office task-pane pages and the LibreOffice extension live.
 *
 * The service build stages them beside the UI (`dist/ui`, `dist/office`,
 * `dist/libreoffice/gezel.oxt`), so the UI directory's sibling is the first
 * answer; module-relative and repo-checkout paths cover `gezeld` run from
 * `dist/bin/` and development.
 */

const OFFICE_MARKER = join('word', 'taskpane.html');
const OXT_NAME = 'gezel.oxt';

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

export function resolveOfficeDir(opts: {
  officeDir?: string;
  uiDir?: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const env = opts.env ?? process.env;
  const here = moduleDir();
  const candidates = [
    opts.officeDir,
    env.GEZEL_OFFICE_DIR,
    opts.uiDir ? join(dirname(opts.uiDir), 'office') : undefined,
    resolve(here, 'office'),
    resolve(here, '../office'),
    resolve(here, '../../../ui/dist-office'),
    resolve(here, '../../ui/dist-office'),
  ];
  for (const c of candidates) {
    if (c && existsSync(join(c, OFFICE_MARKER))) return c;
  }
  return undefined;
}

export function resolveLibreOfficeOxt(opts: {
  oxtPath?: string;
  uiDir?: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const env = opts.env ?? process.env;
  const here = moduleDir();
  const candidates = [
    opts.oxtPath,
    env.GEZEL_LIBREOFFICE_OXT,
    opts.uiDir ? join(dirname(opts.uiDir), 'libreoffice', OXT_NAME) : undefined,
    resolve(here, 'libreoffice', OXT_NAME),
    resolve(here, '../libreoffice', OXT_NAME),
    resolve(here, '../../../libreoffice-extension/dist', OXT_NAME),
    resolve(here, '../../libreoffice-extension/dist', OXT_NAME),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return undefined;
}
