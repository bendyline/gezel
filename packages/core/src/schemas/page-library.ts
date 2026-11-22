import { z } from 'zod';

/**
 * Page libraries: browser-ready JavaScript libraries a page loads from this
 * computer instead of a CDN (docs/page-libraries.md). A **line** is one pinned
 * release of one library, answering a range of the versions a page may ask
 * for, in one or both of the forms a page loads a library in.
 */

/** Shelf id of a library: its npm name without the scope's `@` and `/`. */
export const PageLibraryIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'a page library id is lowercase letters, digits, . _ -');

const ExactVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, 'an exact version, such as 0.185.2');

/** A file inside the package, with `/` separators and no leading slash. */
const PackagePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.split('/').some((part) => part === '..' || part === '.'),
    'a path inside the package',
  );

/**
 * What a page may ask for, mapped to files. A key is `.` (the library itself)
 * or `./sub/path`; a key ending in `/` maps a whole folder and its value must
 * end in `/` too.
 */
const EntriesSchema = z.record(z.string().regex(/^\.(?:\/.+)?$/), PackagePathSchema);

const FormSchema = z.object({
  /** This line answers a request that names no version. One per library and form. */
  default: z.boolean().optional(),
  entries: EntriesSchema,
});

export const PageLibrarySourceSchema = z.object({
  kind: z.literal('npm'),
  package: z.string().min(1).max(214),
  version: ExactVersionSchema,
  /** SHA-256 of the registry tarball. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  publishedAt: z.string().optional(),
});

export const PageLibraryLineSchema = z.object({
  library: PageLibraryIdSchema,
  /** Shown to people and named to models. */
  name: z.string().min(1).max(80),
  version: ExactVersionSchema,
  /**
   * The requested versions this line answers: from `from` up to, not
   * including, `before`. `0.160.0` to `1.0.0` answers `three@0.170`.
   */
  answers: z.object({ from: z.string(), before: z.string().optional() }),
  source: PageLibrarySourceSchema,
  /** npm names a page imports this library by. */
  packages: z.array(z.string().min(1).max(214)).min(1),
  /** Files, and folders ending in `/`, taken from the package. Nothing else is installed. */
  include: z.array(PackagePathSchema).min(1),
  /** Loaded with `import`: an ES module. */
  module: FormSchema.optional(),
  /** Loaded with a plain `<script src>`: sets a global. */
  classic: FormSchema.extend({ global: z.string().optional() }).optional(),
  /** Loaded with `<link rel="stylesheet">`. */
  style: FormSchema.optional(),
  /**
   * Modules made from a plain-script build's global, for a library that
   * publishes no browser module (React 18). Each request (`.`, `./client`)
   * is a small module the shelf writes (core pages/globals.ts): it loads
   * `file`, then exports the global's `exports`. `after` names bare imports
   * to load first (React DOM's build reads React's global). `jsxRuntime`
   * writes React's automatic JSX runtime over the global instead.
   */
  globals: z
    .record(
      z.string().regex(/^\.(?:\/[\w.-]+)*$/),
      z.object({
        global: z.string().regex(/^[A-Za-z_$][\w$]*$/),
        file: PackagePathSchema,
        exports: z.array(z.string().regex(/^[A-Za-z_$][\w$]*$/)).default([]),
        after: z.array(z.string().min(1)).optional(),
        jsxRuntime: z.boolean().optional(),
      }),
    )
    .optional(),
  /**
   * Modules made from a CommonJS file, for a library that publishes neither
   * a browser module nor a plain-script build (React 19). Each request is a
   * module the shelf writes (core pages/globals.ts) that runs `file`, as
   * published, with `require` answered by `imports` (bare imports of this or
   * other lines), then exports `exports`.
   */
  commonjs: z
    .record(
      z.string().regex(/^\.(?:\/[\w.-]+)*$/),
      z.object({
        file: PackagePathSchema,
        exports: z.array(z.string().regex(/^[A-Za-z_$][\w$]*$/)).default([]),
        imports: z.array(z.string().min(1)).default([]),
      }),
    )
    .optional(),
  /** Other spellings of a file: a CDN path on the left, the file served on the right. */
  paths: z.record(PackagePathSchema, PackagePathSchema).optional(),
  /** cdnjs names libraries and lays out files its own way. */
  cdnjs: z
    .object({
      name: z.string().min(1),
      files: z.record(PackagePathSchema, PackagePathSchema).optional(),
    })
    .optional(),
  /** Whole URLs that mean this line, for hosts with no package grammar. */
  urls: z
    .array(
      z.object({
        url: z.string().url(),
        form: z.enum(['module', 'classic', 'style']),
        path: PackagePathSchema,
      }),
    )
    .optional(),
  /** Bare imports this line's own files make of other libraries: npm name to requested version. */
  requires: z.record(z.string(), z.string()).optional(),
  /** SPDX id, and the notice file inside the package that must travel with a copy. */
  license: z.string().min(1),
  notice: PackagePathSchema.optional(),
  /** Where the line can run. A library that needs `eval` or workers cannot run on a phone. */
  hosts: z
    .array(z.enum(['desktop', 'phone']))
    .min(1)
    .default(['desktop']),
  /**
   * The requests a phone build carries (`.`, `./auto`), when not every file
   * request: the phone app bundles its libraries, so three ships `three`
   * and not its 2.4 MB of WebGPU builds. Folder requests never ship.
   */
  phoneRequests: z.array(z.string().regex(/^\.(?:\/[\w.-]+)*$/)).optional(),
});
export type PageLibraryLine = z.infer<typeof PageLibraryLineSchema>;
export type PageLibraryForm = 'module' | 'classic' | 'style';

/** Written beside an installed line; what the shelf trusts when it serves a file. */
export const PAGE_LIBRARY_MARKER = '.gezel-page-library.json';
export const PageLibraryInstallSchema = z.object({
  format: z.literal('gezel-page-library@1'),
  line: PageLibraryLineSchema,
  /** Every installed file, by package path. */
  files: z.record(
    PackagePathSchema,
    z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().nonnegative() }),
  ),
  installedAt: z.string(),
});
export type PageLibraryInstall = z.infer<typeof PageLibraryInstallSchema>;

// ── HTTP wire shapes (`/api/page-libraries`, `/api/projects/:id/page-libraries`) ──

const DownloadBlockSchema = z.enum(['build', 'network', 'setting']);

export const PageLibraryLineStatusSchema = z.object({
  version: z.string(),
  forms: z.array(z.enum(['module', 'classic', 'style'])),
  /** Forms this line answers when a page names no version. */
  defaults: z.array(z.enum(['module', 'classic', 'style'])),
  installed: z.boolean(),
  /** Downloaded into this home; false when it shipped with the app or is not installed. */
  removable: z.boolean(),
  downloading: z.boolean(),
  /** Bytes on disk, when installed. */
  bytes: z.number().int().nonnegative().optional(),
  license: z.string(),
  /** Why the last download failed, within the hour. */
  error: z.string().optional(),
});
export type PageLibraryLineStatus = z.infer<typeof PageLibraryLineStatusSchema>;

export const PageLibrariesResponseSchema = z.object({
  /** Whether downloads may run, and why not. */
  downloads: z.object({
    person: z.boolean(),
    automatic: z.boolean(),
    blocked: DownloadBlockSchema.optional(),
    /** Plain words for a refusal, for the person. */
    refusal: z.string().optional(),
  }),
  autoDownload: z.boolean(),
  libraries: z.array(
    z.object({
      library: z.string(),
      name: z.string(),
      description: z.string().optional(),
      homepage: z.string().optional(),
      lines: z.array(PageLibraryLineStatusSchema),
    }),
  ),
});
export type PageLibrariesResponse = z.infer<typeof PageLibrariesResponseSchema>;

export const PageLibraryNeedsRequestSchema = z.object({
  /** The page, relative to the project workspace. */
  path: z.string().min(1).max(4_096),
  /** How long to wait for downloads, capped by the daemon. */
  waitMs: z.number().int().nonnegative().max(120_000).optional(),
});
export type PageLibraryNeedsRequest = z.infer<typeof PageLibraryNeedsRequestSchema>;

export const PageLibraryNeedsResponseSchema = z.object({
  needed: z.array(
    z.object({
      library: z.string(),
      name: z.string(),
      version: z.string(),
      ready: z.boolean(),
    }),
  ),
  /** Lines that arrived during this request: a preview showing the page should reload. */
  installed: z.array(z.string()),
  pending: z.array(z.string()),
  failed: z.array(z.object({ line: z.string(), error: z.string() })),
  /** Library spellings nothing on the shelf or in the catalog answers. */
  unknown: z.array(
    z.object({ spelling: z.string(), from: z.string(), kind: z.enum(['package', 'url']) }),
  ),
  blocked: DownloadBlockSchema.optional(),
  /** Whether the page's own network policy lets it load a library the shelf lacks. */
  externalNetwork: z.boolean(),
  /** What a page can load here, for a message naming the alternatives (`listedPageLibraries`). */
  available: z.array(z.object({ name: z.string(), version: z.string(), scriptOnly: z.boolean() })),
});
export type PageLibraryNeedsResponse = z.infer<typeof PageLibraryNeedsResponseSchema>;
