/**
 * `./pages` — page libraries: which shelf file a page means by a library
 * spelling, the import map that answers its bare imports, and the rewrite of
 * its CDN addresses (docs/page-libraries.md). The logic is pure, with the
 * compiler and the files handed in, so the desktop preview, the phones and
 * an embedding app such as DocBlocks read a page the same way. The line
 * schema is exported here and not from the main entry, which the app's UI
 * loads at startup.
 */
export * from './resolver.js';
export * from './import-map.js';
export * from './html-rewrite.js';
export * from './collect.js';
export * from './note.js';
export * from './export.js';
export * from './globals.js';
export * from './jsx.js';
export * from './phone.js';
export * from '../schemas/page-library.js';
