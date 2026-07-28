import { PET_SUBJECT_PATTERN, petShopContentSniff } from '../success-check.ts';
import type { EvalScenario } from '../types.ts';
import { type RuntimeAssertion, listAllFiles, pollHtmlSniff } from './helpers.ts';

const IMG_EXT = /\.(?:png|jpe?g|webp|gif)$/i;

interface PetShopExtraContext {
  htmlPath: string;
  projectFiles: string[];
  validRasterFiles: string[];
}

const HTML_FIRST_REPAIR_DIRECTIVE =
  'PETSHOP BUILD ORDER: create `index.html` now as the shipping website. The first HTML write must include `<img src="assets/logo.png" alt="Pet shop logo">`; it is okay if the logo file is generated just before or just after the HTML. Do not spend another turn on logo-only coordination, image-only delegation, or planning while `index.html` is absent. If you are a coordinator, ensure or message a Developer/Builder for this exact `index.html` deliverable, not a Designer/Image Generator; the image specialist only owns `assets/logo.png`.';

function imageSrcHints(htmlPath: string, projectFiles: string[]): string[] {
  return projectFiles
    .filter((file) => IMG_EXT.test(file))
    .map((file) => relativeSrcFromHtml(htmlPath, file))
    .filter((src): src is string => src !== null)
    .sort((a, b) => imageSrcRank(a) - imageSrcRank(b) || a.localeCompare(b))
    .slice(0, 5);
}

function brokenImageSrcHints(html: string, htmlPath: string, projectFiles: string[]): string[] {
  const fileSet = new Set(projectFiles.map((file) => normalizeProjectPath(file)));
  return imageSrcsFromHtml(html)
    .filter((src) => {
      const stripped = stripSrcSuffix(src);
      if (!IMG_EXT.test(stripped)) return false;
      const resolved = resolveSrcFromHtml(htmlPath, src);
      return resolved !== null && !fileSet.has(normalizeProjectPath(resolved));
    })
    .filter(unique)
    .slice(0, 8);
}

function imageSrcsFromHtml(html: string): string[] {
  const srcs: string[] = [];
  const imgRe = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration
  while ((match = imgRe.exec(html)) !== null) {
    const src = match[1] ?? match[2] ?? match[3];
    if (src) srcs.push(src.trim());
  }
  return srcs.filter((src) => src.length > 0);
}

function resolveSrcFromHtml(htmlPath: string, srcRaw: string): string | null {
  if (/^(?:[a-z]+:|\/\/|#|data:|mailto:)/i.test(srcRaw)) return null;
  const src = stripSrcSuffix(srcRaw);
  if (!src) return null;
  if (src.startsWith('/')) return src.slice(1);

  const baseDirParts = htmlPath.split(/[\\/]+/);
  baseDirParts.pop();
  const parts = src.split(/[\\/]+/);
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (baseDirParts.length === 0) return null;
      baseDirParts.pop();
    } else {
      baseDirParts.push(part);
    }
  }
  return baseDirParts.join('/');
}

function relativeSrcFromHtml(htmlPath: string, targetPath: string): string | null {
  const fromParts = htmlPath.replace(/\\/g, '/').split('/').filter(Boolean);
  const toParts = targetPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (fromParts.length === 0 || toParts.length === 0) return null;
  fromParts.pop();

  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i += 1;
  const up = Array.from({ length: fromParts.length - i }, () => '..');
  const down = toParts.slice(i);
  const rel = [...up, ...down].join('/');
  return rel.length > 0 ? rel : null;
}

function stripSrcSuffix(src: string): string {
  return src.replace(/[?#].*$/, '').trim();
}

function normalizeProjectPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.?\//, '');
}

function unique(src: string, index: number, all: string[]): boolean {
  return all.indexOf(src) === index;
}

function imageSrcRank(src: string): number {
  if (!src.startsWith('..')) return 0;
  if (src.startsWith('../artifacts/')) return 2;
  return 1;
}

/**
 * Validate the image elements that the browser actually rendered after
 * inline JavaScript ran. The static sniff proves that *some* valid raster
 * is linked (normally the requested logo); this closes the loophole where
 * that one logo masks missing product-card images inserted dynamically.
 *
 * Only local raster refs are in scope. External/data/anchor refs are left
 * to the scenario's policy, and realistic cache-busting query/hash suffixes
 * are stripped only for path resolution while the original ref is retained
 * in diagnostics.
 */
export function checkRenderedLocalRasterReferences(
  renderedSrcs: readonly string[],
  opts: Pick<PetShopExtraContext, 'htmlPath' | 'validRasterFiles'>,
): { ok: boolean; why?: string } {
  const validRasterSet = new Set(opts.validRasterFiles.map((path) => normalizeProjectPath(path)));
  const localRasterRefs = renderedSrcs
    .map((src) => src.trim())
    .filter(Boolean)
    .map((src) => ({ src, resolved: resolveSrcFromHtml(opts.htmlPath, src) }))
    .filter(
      (entry): entry is { src: string; resolved: string } =>
        entry.resolved !== null && IMG_EXT.test(stripSrcSuffix(entry.src)),
    );

  if (localRasterRefs.length === 0) {
    return { ok: false, why: 'no local raster <img> is rendered in the browser DOM' };
  }

  const broken = localRasterRefs.filter(
    ({ resolved }) => !validRasterSet.has(normalizeProjectPath(resolved)),
  );
  if (broken.length > 0) {
    return {
      ok: false,
      why: `${broken.length} rendered local raster ref(s) do not resolve to valid image bytes: ${broken
        .slice(0, 5)
        .map(({ src }) => src)
        .join(', ')}`,
    };
  }
  return { ok: true };
}

export function petShopRuntimeAssertions(extra: PetShopExtraContext): RuntimeAssertion[] {
  return [
    {
      name: 'all-rendered-local-images-resolve',
      test: async (page) => {
        // Dynamic product grids commonly populate from `window.onload`.
        // Wait for that event before inspecting the DOM rather than only
        // the pre-script source. Relative images may 404 under setContent;
        // byte validity comes from the captured workspace context below.
        try {
          await page.waitForLoadState('load', { timeout: 2_000 });
        } catch {
          // The outer runtime report owns load/bootstrap failures. Still
          // inspect whatever DOM is present so this assertion is useful.
        }
        // A common product-grid shape schedules its first render from a
        // short timer after `load`. Give that bounded work one turn to land;
        // otherwise a valid static logo can mask a broken product image that
        // appears just after the immediate DOM snapshot.
        await page.waitForTimeout(100);
        const renderedSrcs = await page.evaluate(() =>
          Array.from(document.querySelectorAll('img'))
            .map((img) => img.getAttribute('src') ?? '')
            .filter(Boolean),
        );
        return checkRenderedLocalRasterReferences(renderedSrcs, extra);
      },
    },
  ];
}

export function isValidRasterAsset(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const containsAscii = (token: string): boolean => {
    const wanted = [...token].map((char) => char.charCodeAt(0));
    outer: for (let i = 0; i <= bytes.length - wanted.length; i++) {
      for (let j = 0; j < wanted.length; j++) {
        if (bytes[i + j] !== wanted[j]) continue outer;
      }
      return true;
    }
    return false;
  };
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
    (value, index) => bytes[index] === value,
  );
  const png =
    pngSignature &&
    String.fromCharCode(...bytes.slice(12, 16)) === 'IHDR' &&
    containsAscii('IDAT') &&
    containsAscii('IEND');
  const jpeg =
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9;
  const gif =
    (String.fromCharCode(...bytes.slice(0, 6)) === 'GIF87a' ||
      String.fromCharCode(...bytes.slice(0, 6)) === 'GIF89a') &&
    bytes.includes(0x2c) &&
    bytes[bytes.length - 1] === 0x3b;
  const webp =
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP' &&
    ['VP8 ', 'VP8L', 'VP8X'].includes(String.fromCharCode(...bytes.slice(12, 16)));
  // A bare magic header is just as gameable as an extension. One KiB
  // is intentionally modest: it rejects placeholders while accepting
  // aggressively optimized real logos.
  return bytes.length >= 1024 && (png || jpeg || gif || webp);
}

async function findValidRasterFiles(
  client: Parameters<typeof listAllFiles>[0],
  files: Awaited<ReturnType<typeof listAllFiles>>,
): Promise<string[]> {
  const checks = await Promise.all(
    files
      .filter((file) => IMG_EXT.test(file.filePath))
      .map(async (file) => {
        try {
          const blob =
            file.surface === 'workspace'
              ? await client.fetchProjectWorkspaceBlob(file.projectId, file.filePath)
              : await client.fetchProjectArtifactBlob(file.projectId, file.filePath);
          const bytes = new Uint8Array(await blob.arrayBuffer());
          return isValidRasterAsset(bytes) ? file.rooted : null;
        } catch {
          return null;
        }
      }),
  );
  return checks.filter((path): path is string => path !== null);
}

export const petShopScenario: EvalScenario = {
  id: 'petshop',
  description:
    'Meester orchestrates a multi-tool job: developer builds a pet shop HTML site, image-generator renders a custom logo, and the page references it.',
  prompt:
    'Build me a single-page pet shop website with a custom logo. ' +
    'Create the shipping `index.html` in the website workspace first, with the logo wired in as <img src="assets/logo.png" alt="Pet shop logo"> from the first write. ' +
    'For the logo I want an AI-generated image (PNG file) — please use the image-generation tool to render it, ' +
    'save it in the website workspace as `assets/logo.png` using `generate_image({ saveAs: "assets/logo.png" })`, ' +
    'and reference it from an <img src="assets/logo.png"> tag. ' +
    'Use one project/workspace for the whole website and logo; do not create a separate logo-only project. ' +
    'Do not wait to write the HTML until after image generation; the Developer/Builder owns `index.html`, while any image specialist only owns `assets/logo.png`. ' +
    'No build step, no inline SVG substitution.',
  requiredPromptEvidence: [{ signal: 'pet-vocab', pattern: PET_SUBJECT_PATTERN }],
  // Image generation is the slow path. SDXL Lightning 4-step (the default
  // here) renders in ~5-10s per image vs 30-60s on the
  // SDXL Base 30-step path the scenario shipped with; same checkpoint
  // family, same quality envelope for a logo deliverable, ~5-6× faster
  // per render. On gemma4-e4b (tier:tiny) prefill of the heavy designer
  // system prompt + tool schema is ~8 min on its own; one image render
  // + one HTML write adds another ~3-5 min. The eval bundle
  // showed Vihaan generating a real PNG at ~27 min on SDXL Base and
  // timing out 3 min later before HTML — switching to Lightning gives
  // back enough budget for one re-render if the first generation is
  // off-brief. Generous wall-clock backstop only (2 h): the no-progress
  // watchdog (45 min) and the count-based retry-loop are the real
  // terminators. Image gen + multi-role handoff is slow at low t/s, and
  // the eval is throughput-invariant — never fail it for running long.
  timeoutMs: 120 * 60_000,
  defaultImageModelId: 'sdxl-lightning-4step',
  successCheck: async (ctx) =>
    pollHtmlSniff({
      ctx,
      // petshop sniff needs (a) the html's project-rooted path and (b) the
      // full project file list (so it can resolve `<img src>` references
      // against actually-on-disk files). The shared helper hands us the
      // file ref + lets us fetch the project file list once per project.
      sniff: (html, extra: PetShopExtraContext) => petShopContentSniff(html, extra),
      getExtraContext: async (client, ref, project) => {
        const files = await listAllFiles(client, project.id);
        return {
          htmlPath: `${ref.surface}/${ref.filePath}`,
          projectFiles: files.map((f) => f.rooted),
          validRasterFiles: await findValidRasterFiles(client, files),
        };
      },
      runtimeAssertions: (_html, extra) => petShopRuntimeAssertions(extra),
      sniffFeedback: (extra, _ref, project, html, sniff) => {
        // Only advertise byte-validated rasters as reusable assets. An
        // extension-only placeholder must route back to image generation,
        // not trap the HTML developer in a "reference the existing PNG"
        // loop when that PNG is not actually an image.
        const availableImageSrcs = imageSrcHints(extra.htmlPath, extra.validRasterFiles);
        const missingSignals = sniff.missingRequiredSignals ?? [];
        const missingImageAsset =
          availableImageSrcs.length === 0 && missingSignals.includes('image-asset');
        return {
          availableImageSrcs,
          brokenImageSrcs: brokenImageSrcHints(html, extra.htmlPath, extra.projectFiles),
          projectId: project.id,
          notifyMeester: true,
          expectedDeliverable: missingImageAsset ? null : undefined,
          assetHandoff: missingImageAsset
            ? {
                jobTitle: 'Image generator',
                filePath: 'assets/logo.png',
                message:
                  'Generate the missing pet shop logo as a real PNG image in this project workspace. Your first action must be `generate_image({ prompt: "friendly pet shop logo, paw print, warm colors", saveAs: "assets/logo.png" })`. Do not call `write_file`, do not paste base64, and do not create an SVG. The HTML already references `<img src="assets/logo.png" alt="Pet shop logo">`, so the acceptance check needs the actual raster file at `assets/logo.png`.',
              }
            : undefined,
        };
      },
      missingDeliverablePath: 'index.html',
      missingDeliverableFeedback: {
        maxNudges: 6,
        repeatEvery: 24,
        coordinatorFallbackAfterPolls: 36,
        repairDirective: HTML_FIRST_REPAIR_DIRECTIVE,
      },
    }),
};
