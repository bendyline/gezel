import { configureMonacoWorkers } from '@bendyline/squisq-editor-react/monaco-workers';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

/**
 * Monaco's language-service workers must be bundled by the host application.
 * Squisq demand-loads the matching service when a code file opens; this routes
 * that service to Vite's worker bundles without pulling Monaco itself into the
 * eager application graph.
 *
 * Keep this as the single worker setup for both Squisq and Gezel's standalone
 * Monaco editors so every surface uses the same MonacoEnvironment.
 */
configureMonacoWorkers({
  editor: EditorWorker,
  json: JsonWorker,
  css: CssWorker,
  html: HtmlWorker,
  ts: TsWorker,
});
