'use strict';

/**
 * First-party replacement for pnpm's optional @reflink native addon.
 *
 * Node exposes the same copy-on-write operation through COPYFILE_FICLONE_FORCE.
 * pnpm already falls back to an ordinary copy when this function reports
 * ENOTSUP, so normalize platform/filesystem-specific "cannot clone" errors to
 * that portable contract. COPYFILE_EXCL preserves @reflink's EEXIST behavior.
 */
const { constants, copyFileSync } = require('node:fs');
const { copyFile } = require('node:fs/promises');

const REFLINK_FLAGS = constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE;
const UNSUPPORTED_CODES = new Set(['EINVAL', 'ENOSYS', 'EXDEV']);

function normalizeUnsupportedError(error) {
  if (error && typeof error === 'object' && UNSUPPORTED_CODES.has(error.code)) {
    error.code = 'ENOTSUP';
  }
  return error;
}

async function reflinkFile(src, dest) {
  try {
    await copyFile(src, dest, REFLINK_FLAGS);
    return 0;
  } catch (error) {
    throw normalizeUnsupportedError(error);
  }
}

function reflinkFileSync(src, dest) {
  try {
    copyFileSync(src, dest, REFLINK_FLAGS);
    return 0;
  } catch (error) {
    throw normalizeUnsupportedError(error);
  }
}

module.exports = {
  reflinkFile,
  reflinkFileSync,
  normalizeUnsupportedError,
};
