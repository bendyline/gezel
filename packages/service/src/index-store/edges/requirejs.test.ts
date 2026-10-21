import { describe, expect, it } from 'vitest';
import { parseRequireJsConfig, requireJsConfigFor, requireJsPage } from './requirejs.js';

describe('RequireJS pages', () => {
  it('finds the data-main script and other local scripts of a page that loads the loader', () => {
    const page = requireJsPage(
      `<script src="https://cdn.example/jquery.js"></script>
       <script src="config.js?v=2"></script>
       <script src="thirdparty/requirejs/require.min.js" data-main="main"></script>`,
      'src/index.html',
    );
    expect(page).toEqual({ dataMain: 'src/main.js', scripts: ['src/config.js'] });
  });

  it('ignores a page that does not load RequireJS', () => {
    expect(requireJsPage('<script src="app.js"></script>', 'index.html')).toBeNull();
  });
});

describe('RequireJS config', () => {
  it('reads baseUrl and paths, through comments and both key styles', () => {
    const parsed = parseRequireJsConfig(`
      // the file system implementation
      require.config({
        baseUrl: "../src", /* relative to the page */
        paths: {
          "text"  : "thirdparty/text/text",
          spec: '../test/spec',
          jquery: ["https://cdn.example/jquery", "thirdparty/jquery"],
          cdn: "http://example.com/lib" // a URL stays a URL
        },
        map: { "*": { "a": "b" } }
      });
    `);
    expect(parsed.baseUrl).toBe('../src');
    expect(parsed.paths).toEqual({
      text: 'thirdparty/text/text',
      spec: '../test/spec',
      jquery: 'https://cdn.example/jquery',
      cdn: 'http://example.com/lib',
    });
  });

  it('reads a global config object set before the loader', () => {
    expect(parseRequireJsConfig('var require = { baseUrl: "js/lib" };').baseUrl).toBe('js/lib');
  });

  it('puts the base at baseUrl from the page, else the data-main folder, else the page', () => {
    expect(
      requireJsConfigFor('test/SpecRunner.html', { dataMain: 'test/SpecRunner.js' }, [
        'require.config({ baseUrl: "../src" });',
      ]),
    ).toEqual({ pageDir: 'test', baseDir: 'src', paths: {} });
    expect(
      requireJsConfigFor('index.html', { dataMain: 'js/app/main.js' }, ['define([], 1);']),
    ).toMatchObject({ baseDir: 'js/app' });
    expect(requireJsConfigFor('web/index.html', { dataMain: null }, [])).toMatchObject({
      baseDir: 'web',
    });
  });
});
