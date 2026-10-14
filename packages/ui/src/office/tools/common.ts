import { type PaneTool, READ_TIMEOUT_MS, clip, toJson } from './shared.js';

export interface DocumentDescription {
  host: string;
  title: string;
  path: string | null;
  projectId: string;
  projectName: string;
  projectReadOnly: boolean;
  editsEnabled: boolean;
}

/** Selected text in any host, through Office's common API. */
export function readSelectedText(): Promise<string> {
  return new Promise((resolve, reject) => {
    Office.context.document.getSelectedDataAsync(Office.CoercionType.Text, (result) => {
      if (result.status === Office.AsyncResultStatus.Succeeded) resolve(String(result.value ?? ''));
      else reject(new Error(result.error?.message ?? 'Could not read the selection.'));
    });
  });
}

/**
 * The selection tool. Gezel also calls it at the start of each turn the person
 * sends (the pane registers it as its subject's `stateTool`), so its answer is
 * what opens their message: keep it cheap, and keep `isDocumentEmpty` to hosts
 * that can answer without reading the whole file.
 */
export const SELECTION_TOOL = 'office_read_selection';

export function commonTools(opts: {
  describe: () => DocumentDescription;
  readSelection?: () => Promise<string>;
  /** Whether the document has no content at all. Word only; others omit it. */
  isDocumentEmpty?: () => Promise<boolean>;
}): PaneTool[] {
  const readSelection = opts.readSelection ?? readSelectedText;
  return [
    {
      name: 'office_describe_document',
      description:
        'Describe the document open beside this chat: which Office app, its name and location, its gezel project, and whether you may edit it.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: READ_TIMEOUT_MS,
      handler: () => toJson(opts.describe()),
    },
    {
      name: SELECTION_TOOL,
      description: 'Read the text the user has selected in the open document, in any Office app.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: READ_TIMEOUT_MS,
      handler: async () => {
        const text = await readSelection();
        const clipped = clip(text);
        const isEmpty = text.trim().length === 0;
        // Only worth asking when nothing is selected: "add a paragraph" into
        // an empty document needs no question about where it goes.
        const documentIsEmpty =
          isEmpty && opts.isDocumentEmpty
            ? await opts.isDocumentEmpty().catch(() => undefined)
            : undefined;
        return toJson({
          isEmpty,
          text: clipped.text,
          truncated: clipped.truncated,
          ...(documentIsEmpty !== undefined ? { documentIsEmpty } : {}),
        });
      },
    },
  ];
}
