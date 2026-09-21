import { readFile } from 'node:fs/promises';
import { parseScriptMeta } from '@bendyline/gezel-script-runtime/meta';
export { ScriptMetaError, parseScriptMeta } from '@bendyline/gezel-script-runtime/meta';

export async function readScriptMeta(scriptPath: string) {
  return parseScriptMeta(await readFile(scriptPath, 'utf8'), scriptPath);
}
