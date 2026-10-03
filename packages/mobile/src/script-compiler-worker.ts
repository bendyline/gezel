import type { ScriptTemplateId } from '@bendyline/gezel';
import { compilePortableScript } from '@bendyline/gezel-script-runtime/compile';
import { compilePreviewModule } from '@bendyline/gezel-script-runtime/preview-module';
import { scaffoldScript } from '@bendyline/gezel-script-runtime/source';
const port = globalThis as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(value: unknown): void;
  close(): void;
};
port.onmessage = (event) => {
  const preview = event.data as {
    kind?: 'preview-modules';
    id: number;
    modules: { path: string; source: string }[];
  };
  // A preview compiles its import graph a round at a time through one
  // compiler, which loads TypeScript once; the caller ends the worker.
  if (preview.kind === 'preview-modules') {
    try {
      port.postMessage({
        id: preview.id,
        value: preview.modules.map(({ path, source }) => ({
          path,
          ...compilePreviewModule(source, path, 'commonjs'),
        })),
      });
    } catch (error) {
      port.postMessage({
        id: preview.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  try {
    const request = event.data as {
      name: string;
      source?: string;
      description?: string;
      template?: ScriptTemplateId;
    };
    const value =
      request.source === undefined
        ? scaffoldScript(request.name, request.description, request.template)
        : compilePortableScript(request.source, request.name);
    port.postMessage({ value });
  } catch (error) {
    port.postMessage({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    port.close();
  }
};
