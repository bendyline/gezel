/** Refresh the offline copies after editing the host's canonical component runtime. */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pageComponentsSource } from '../packages/core/src/project-types/page-components.js';

const gilde = resolve(process.env.GILDE_DIR ?? '../gilde');
const source = `${pageComponentsSource()}\n`;
for (const path of [
  'authoring/page-components.js',
  'data/project-types/me/media-library/versions/1.0.0/pages/page-components.js',
  'data/project-types/da/data-analysis/versions/1.0.0/pages/page-components.js',
]) {
  await writeFile(resolve(gilde, path), source);
  console.log(`Updated ${path}`);
}
