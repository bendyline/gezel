/**
 * Remove sourceMappingURL comments from built JavaScript without deleting the
 * map files themselves. Published npm packages exclude `*.map`; leaving the
 * comments behind makes browsers and debuggers request files that cannot
 * exist in the installed package.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LINE_COMMENT = /^[\t ]*\/\/[#@]\s*sourceMappingURL=[^\r\n]*(?:\r?\n|$)/gm;
const BLOCK_COMMENT = /\/\*[#@]\s*sourceMappingURL=[\s\S]*?\*\//g;
const JAVASCRIPT_EXTENSION = /\.(?:c|m)?js$/i;

export function stripSourcemapCommentsFromText(source) {
  let commentsRemoved = 0;
  const withoutLines = source.replace(LINE_COMMENT, () => {
    commentsRemoved += 1;
    return '';
  });
  const text = withoutLines.replace(BLOCK_COMMENT, () => {
    commentsRemoved += 1;
    return '';
  });
  return { text, commentsRemoved };
}

export async function stripSourcemapComments(roots) {
  let filesChanged = 0;
  let commentsRemoved = 0;

  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (!entry.isFile() || !JAVASCRIPT_EXTENSION.test(entry.name)) continue;

      const source = await readFile(child, 'utf8');
      const stripped = stripSourcemapCommentsFromText(source);
      if (stripped.commentsRemoved === 0) continue;
      await writeFile(child, stripped.text);
      filesChanged += 1;
      commentsRemoved += stripped.commentsRemoved;
    }
  }

  for (const root of roots) await walk(resolve(root));
  return { filesChanged, commentsRemoved };
}

export async function stripSourcemapCommentsFromBuild(root = 'dist') {
  const result = await stripSourcemapComments([root]);
  console.log(
    `[strip-sourcemaps] removed ${result.commentsRemoved} comment(s) from ${result.filesChanged} JavaScript file(s)`,
  );
  return result;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const roots = process.argv.slice(2);
  if (roots.length === 0) {
    throw new Error('usage: strip-sourcemap-comments.mjs <build-dir> [...]');
  }
  if (roots.length === 1) await stripSourcemapCommentsFromBuild(roots[0]);
  else {
    const result = await stripSourcemapComments(roots);
    console.log(
      `[strip-sourcemaps] removed ${result.commentsRemoved} comment(s) from ${result.filesChanged} JavaScript file(s)`,
    );
  }
}
