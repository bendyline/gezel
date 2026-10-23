/** Legacy adapter, retained for older catalog pages. New pages receive it from the demo host. */
export const PAGE_DEMO_STUB = `/* gezel-page-demo-stub v1 */
/*
 * The canonical demo stub for Gezel type pages. MIT License.
 *
 * Paste this file's bytes verbatim into a <script> block ahead of the
 * page's own code, then call makeDemoGezel({ page, tools, data }) with the
 * page's demo handlers. Served by Gezel, the real window.gezel is already
 * injected and the stub steps aside; opened as a raw file (the live demos
 * on gezelgilde.com), it installs a window.gezel whose tools and data are
 * the page-supplied handler maps — one code path in every mode. \`tools\`
 * and \`data\` map a tool name / declared read path to a function; data
 * handlers back read() and list(), and url() returns the handler's value
 * or passes a data: URI through. See docs/page-authoring.md.
 */
(function () {
  'use strict';
  window.makeDemoGezel = function (opts) {
    if (window.gezel) return window.gezel;
    var page = (opts && opts.page) || {};
    var tools = (opts && opts.tools) || {};
    var data = (opts && opts.data) || {};
    var themeListeners = [];
    var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    var ui = {
      theme: { mode: media && media.matches ? 'dark' : 'light' },
      onTheme: function (cb) {
        themeListeners.push(cb);
        return function () {
          var at = themeListeners.indexOf(cb);
          if (at >= 0) themeListeners.splice(at, 1);
        };
      },
    };
    if (media && media.addEventListener) {
      media.addEventListener('change', function (ev) {
        ui.theme = { mode: ev.matches ? 'dark' : 'light' };
        themeListeners.slice().forEach(function (cb) { cb(ui.theme); });
      });
    }
    function fail(code, message) {
      var err = new Error(message);
      err.code = code;
      return Promise.reject(err);
    }
    function run(map, key, arg) {
      if (!Object.prototype.hasOwnProperty.call(map, key)) return null;
      return Promise.resolve().then(function () { return map[key](arg); });
    }
    window.gezel = {
      page: {
        api: 1,
        projectId: 'demo',
        source: 'type',
        entry: page.entry || 'index.html',
        typeName: page.typeName || 'demo',
        params: page.params || {},
        mode: 'demo',
      },
      tools: {
        list: function () { return Promise.resolve(Object.keys(tools)); },
        invoke: function (name, input) {
          var call = run(tools, name, input || {});
          if (!call) return fail('not-allowed', "The demo does not handle the tool '" + name + "'.");
          return call.then(function (output) { return { output: output }; });
        },
      },
      data: {
        read: function (path, o) {
          return run(data, path, o || {}) || fail('not-allowed', "The demo has no data for '" + path + "'.");
        },
        list: function (path, o) {
          return run(data, path, o || {}) || Promise.resolve([]);
        },
        watch: function () { return function () {}; },
        url: function (path) {
          if (Object.prototype.hasOwnProperty.call(data, path)) return String(data[path]({}));
          return typeof path === 'string' && path.indexOf('data:') === 0 ? path : '';
        },
      },
      ui: ui,
      refresh: function () {},
    };
    return window.gezel;
  };
})();
`;
