import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function checksum(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

function safeRelative(relative) {
  return (
    typeof relative === 'string' &&
    relative &&
    !relative.includes('\\') &&
    !relative.includes('\0') &&
    !path.posix.isAbsolute(relative) &&
    relative.split('/').every((part) => part && part !== '.' && part !== '..')
  );
}

/** Replace only the explicitly generated paths. Stage and verify the complete
 * set before publishing anything; replacement (not recursive merge) removes
 * obsolete libraries/licenses. Keep originals for rollback until all paths land. */
export async function replaceNativeAssets(replacements) {
  const targets = replacements.map(({ target }) => path.resolve(target));
  if (
    targets.some((target, index) =>
      targets.some(
        (other, otherIndex) =>
          index !== otherIndex && (target === other || target.startsWith(`${other}${path.sep}`)),
      ),
    )
  )
    throw new Error('Native replacement paths must be distinct and cannot contain each other.');
  const staged = [];
  let complete = false;
  let rollbackFailed = false;
  try {
    for (const [index, replacement] of replacements.entries()) {
      const target = targets[index];
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = await mkdtemp(path.join(path.dirname(target), '.gezel-native-stage-'));
      const entry = {
        target,
        temporary,
        next: path.join(temporary, 'next'),
        previous: path.join(temporary, 'previous'),
        moved: false,
        published: false,
      };
      staged.push(entry);
      if ('content' in replacement) {
        await writeFile(entry.next, replacement.content);
      } else {
        if (!replacement.files?.length)
          throw new Error('A generated native directory cannot be empty.');
        await mkdir(entry.next);
        const names = new Set();
        for (const file of replacement.files) {
          if (
            !safeRelative(file.relative) ||
            names.has(file.relative) ||
            !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')
          )
            throw new Error(`Invalid verified native asset: ${file.relative}`);
          names.add(file.relative);
          const destination = path.join(entry.next, file.relative);
          await mkdir(path.dirname(destination), { recursive: true });
          await copyFile(file.source, destination);
          if ((await checksum(destination)) !== file.sha256)
            throw new Error(`Native asset changed while staging: ${file.relative}`);
        }
      }
    }
    for (const entry of staged) {
      try {
        const original = await lstat(entry.target);
        if (original.isSymbolicLink())
          throw new Error(`Refusing to replace a linked native output: ${entry.target}`);
        await rename(entry.target, entry.previous);
        entry.moved = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await rename(entry.next, entry.target);
      entry.published = true;
    }
    complete = true;
  } catch (error) {
    const failures = [];
    for (const entry of [...staged].reverse()) {
      try {
        if (entry.published) await rm(entry.target, { recursive: true, force: true });
        if (entry.moved) await rename(entry.previous, entry.target);
      } catch (failure) {
        rollbackFailed = true;
        failures.push(failure);
      }
    }
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        'Native asset replacement failed. Previous assets remain in .gezel-native-stage-* directories for recovery.',
      );
    throw error;
  } finally {
    // If rollback itself failed, never delete the retained original files.
    if (complete || !rollbackFailed)
      for (const entry of staged) await rm(entry.temporary, { recursive: true, force: true });
  }
}
