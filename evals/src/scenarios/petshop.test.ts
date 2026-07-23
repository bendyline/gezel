import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderAndAssert } from '../html-validation.ts';
import { petShopContentSniff } from '../success-check.ts';
import { runtimeReportForGate } from './helpers.ts';
import {
  checkRenderedLocalRasterReferences,
  isValidRasterAsset,
  petShopRuntimeAssertions,
} from './petshop.ts';

const FROZEN_MALFORMED_PATH = fileURLToPath(
  new URL('./fixtures/petshop-gemma4-e4b-q8-2026-07-10-malformed.html', import.meta.url),
);

const runtimeHtml = (productSrc: string, scriptPrefix = '') => `<!doctype html>
<html><head><title>Pawfect Pet Shop</title></head><body>
  <header><h1>Pawfect Pet Shop</h1><img src="assets/logo.png?v=2" alt="logo"></header>
  <main><section class="products" id="products">Browse our pet store.</section></main>
  <footer>Contact</footer>
  <script>
    ${scriptPrefix}
    const productImage = document.createElement('img');
    productImage.src = ${JSON.stringify(productSrc)};
    productImage.alt = 'Cat food';
    document.getElementById('products').appendChild(productImage);
  </script>
</body></html>`;

describe('petshop raster asset validation', () => {
  it('accepts a non-trivial PNG payload', () => {
    const onePixelPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const bytes = new Uint8Array(1024);
    bytes.set(onePixelPng);
    expect(isValidRasterAsset(bytes)).toBe(true);
  });

  it('rejects an extension-only placeholder payload', () => {
    expect(isValidRasterAsset(new TextEncoder().encode('not really a png'))).toBe(false);
  });

  it('rejects a bare image magic header with no real payload', () => {
    expect(
      isValidRasterAsset(
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
      ),
    ).toBe(false);
  });
});

describe('petshop browser/runtime validation', () => {
  it('rejects the exact frozen malformed artifact even though its real logo satisfies static image evidence', () => {
    const repositoryFixture = readFileSync(FROZEN_MALFORMED_PATH, 'utf8');
    // The captured artifact had no final newline; the repository fixture
    // keeps normal POSIX text-file termination. Verify every frozen byte.
    const frozen = repositoryFixture.endsWith('\n')
      ? repositoryFixture.slice(0, -1)
      : repositoryFixture;
    expect(frozen).toHaveLength(3_681);
    expect(createHash('sha256').update(frozen).digest('hex')).toBe(
      '1b1259896228547e98f856a32c4795cc944180cbbb33b118ad9870507e4707aa',
    );

    const result = petShopContentSniff(frozen, {
      htmlPath: 'workspace/index.html',
      projectFiles: ['workspace/index.html', 'workspace/assets/logo.png'],
      validRasterFiles: ['workspace/assets/logo.png'],
    });

    expect(result).toMatchObject({
      ok: false,
      score: 4,
      scoreMax: 5,
      signals: ['pet-vocab', 'store-vocab', 'working-image', 'image-asset'],
    });
    expect(result.failReason).toMatch(/inline JS does not parse/i);
  });

  it('accepts every rendered local raster when query/hash suffixes resolve to valid bytes', async () => {
    const extra = {
      htmlPath: 'workspace/index.html',
      projectFiles: [
        'workspace/index.html',
        'workspace/assets/logo.png',
        'workspace/assets/cat.jpg',
      ],
      validRasterFiles: ['workspace/assets/logo.png', 'workspace/assets/cat.jpg'],
    };
    const html = runtimeHtml('assets/cat.jpg?width=640#card');
    expect(petShopContentSniff(html, extra)).toMatchObject({
      ok: true,
      score: 5,
      scoreMax: 5,
    });

    const report = runtimeReportForGate(
      await renderAndAssert(html, petShopRuntimeAssertions(extra)),
    );
    expect(report.ran).toBe(true);
    expect(report.failed).toEqual([]);
    expect(report.passed).toEqual(['all-rendered-local-images-resolve']);
  });

  it('does not let a valid logo mask a missing dynamically rendered product image', async () => {
    const extra = {
      htmlPath: 'workspace/index.html',
      projectFiles: ['workspace/index.html', 'workspace/assets/logo.png'],
      validRasterFiles: ['workspace/assets/logo.png'],
    };
    const html = runtimeHtml('assets/cat.jpg?v=missing');
    // Static evidence still sees the requested real logo. Runtime must
    // inspect the post-script DOM and catch the missing product raster.
    expect(petShopContentSniff(html, extra).ok).toBe(true);

    const report = runtimeReportForGate(
      await renderAndAssert(html, petShopRuntimeAssertions(extra)),
    );
    expect(report.failed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'all-rendered-local-images-resolve',
          why: expect.stringContaining('assets/cat.jpg?v=missing'),
        }),
      ]),
    );
  });

  it('waits for short post-load product rendering before validating local rasters', async () => {
    const extra = {
      htmlPath: 'workspace/index.html',
      projectFiles: ['workspace/index.html', 'workspace/assets/logo.png'],
      validRasterFiles: ['workspace/assets/logo.png'],
    };
    const html = `<!doctype html><html><head><title>Pawfect Pet Shop</title></head><body>
      <header><h1>Pawfect Pet Shop</h1><img src="assets/logo.png" alt="logo"></header>
      <main><section id="products">Browse our pet store.</section></main><footer>Contact</footer>
      <script>setTimeout(() => {
        const image = document.createElement('img');
        image.src = 'assets/delayed-cat.png';
        document.getElementById('products').appendChild(image);
      }, 25);</script>
    </body></html>`;
    expect(petShopContentSniff(html, extra).ok).toBe(true);

    const report = runtimeReportForGate(
      await renderAndAssert(html, petShopRuntimeAssertions(extra)),
    );
    expect(report.failed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'all-rendered-local-images-resolve',
          why: expect.stringContaining('assets/delayed-cat.png'),
        }),
      ]),
    );
  });

  it('promotes a parseable inline-script runtime exception to a gate failure', async () => {
    const extra = {
      htmlPath: 'workspace/index.html',
      projectFiles: ['workspace/index.html', 'workspace/assets/logo.png'],
      validRasterFiles: ['workspace/assets/logo.png'],
    };
    const html = runtimeHtml('https://images.example.test/cat.jpg', "throw new Error('boom');");
    expect(petShopContentSniff(html, extra).ok).toBe(true);

    const report = runtimeReportForGate(
      await renderAndAssert(html, petShopRuntimeAssertions(extra)),
    );
    expect(report.failed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'no-page-errors',
          why: expect.stringContaining('boom'),
        }),
      ]),
    );
  });

  it('reports local rendered refs deterministically while ignoring external images', () => {
    expect(
      checkRenderedLocalRasterReferences(
        ['assets/logo.png?v=2', 'https://cdn.example.test/cat.jpg'],
        {
          htmlPath: 'workspace/index.html',
          validRasterFiles: ['workspace/assets/logo.png'],
        },
      ),
    ).toEqual({ ok: true });
  });
});
