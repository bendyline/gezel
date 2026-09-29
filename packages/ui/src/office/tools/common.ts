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

export function commonTools(opts: {
  describe: () => DocumentDescription;
  readSelection?: () => Promise<string>;
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
      name: 'office_read_selection',
      description: 'Read the text the user has selected in the open document, in any Office app.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: READ_TIMEOUT_MS,
      handler: async () => {
        const text = await readSelection();
        const clipped = clip(text);
        return toJson({
          isEmpty: text.trim().length === 0,
          text: clipped.text,
          truncated: clipped.truncated,
        });
      },
    },
  ];
}
