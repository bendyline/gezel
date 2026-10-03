/**
 * For a host whose app previews a project's HTML pages itself and has no
 * server, terminal or package manager: the phones. Told nothing, a model
 * writes a desktop project and tells the person to open localhost.
 */
export const IN_APP_WEB_PREVIEW_GUIDANCE =
  '**Web pages.** The person runs a web page by opening its HTML file in this app; there is no local server, terminal or npm here. Write `index.html` and load your code with `<script type="module" src="./src/main.ts"></script>`. TypeScript and imports between project files work; npm packages do not. Never tell the person to open localhost or run a build.';
