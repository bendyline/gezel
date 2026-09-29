import type { AppToolDefinition } from '@bendyline/gezel-app-sdk/browser';
import type { OfficeHostApp } from '../host.js';
import { type DocumentDescription, commonTools } from './common.js';
import { type ExcelWorkbook, excelTools, officeExcelWorkbook } from './excel.js';
import { type PowerPointDeck, officePowerPointDeck, powerpointTools } from './powerpoint.js';
import type { PaneTool } from './shared.js';
import { type WordDocument, officeWordDocument, wordTools } from './word.js';

export interface ToolsForHostOptions {
  host: OfficeHostApp;
  edits: boolean;
  describe: () => DocumentDescription;
  isSupported: (set: string, version: string) => boolean;
  adapters?: {
    word?: WordDocument;
    excel?: ExcelWorkbook;
    powerpoint?: PowerPointDeck;
    readSelection?: () => Promise<string>;
  };
}

/**
 * The tools this pane offers its project's gezels. Write tools are withdrawn
 * (not refused) while edits are off, and a tool whose Office.js requirement
 * set this Office does not have is never offered: a missing tool is better
 * for the model than one that fails every call.
 */
export function toolsForHost(opts: ToolsForHostOptions): AppToolDefinition[] {
  const all: PaneTool[] = [
    ...commonTools({
      describe: opts.describe,
      ...(opts.adapters?.readSelection ? { readSelection: opts.adapters.readSelection } : {}),
    }),
  ];
  if (opts.host === 'word') all.push(...wordTools(opts.adapters?.word ?? officeWordDocument()));
  if (opts.host === 'excel') all.push(...excelTools(opts.adapters?.excel ?? officeExcelWorkbook()));
  if (opts.host === 'powerpoint') {
    all.push(
      ...powerpointTools(
        opts.adapters?.powerpoint ??
          officePowerPointDeck({ canMoveSlides: () => opts.isSupported('PowerPointApi', '1.8') }),
      ),
    );
  }
  return all
    .filter((tool) => opts.edits || !tool.write)
    .filter((tool) => !tool.requires || opts.isSupported(tool.requires.set, tool.requires.version))
    .map(({ write: _write, requires: _requires, ...tool }) => tool);
}
