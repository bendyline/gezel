import type { ScriptTemplateId } from '@bendyline/gezel';
import { compilePortableScript } from '@bendyline/gezel-script-runtime/compile';
import { scaffoldScript } from '@bendyline/gezel-script-runtime/source';
const port = globalThis as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(value: unknown): void;
  close(): void;
};
port.onmessage = (event) => {
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
