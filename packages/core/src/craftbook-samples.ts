/**
 * The folder every file of a craftbook sample shares, so a sample lands as its
 * own contents on either host: `samples/team-sync/notes.md` is copied as
 * `notes.md`, and a code sample keeps its tree below `samples/app/`.
 */
export function sampleCommonDir(files: readonly string[]): string {
  const dirs = files.map((f) => f.split('/').slice(0, -1));
  const first = dirs[0] ?? [];
  let depth = first.length;
  for (const dir of dirs) {
    let i = 0;
    while (i < depth && i < dir.length && dir[i] === first[i]) i++;
    depth = i;
  }
  return depth === 0 ? '' : `${first.slice(0, depth).join('/')}/`;
}
