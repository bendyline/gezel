import {
  BUILTIN_TOOLSETS,
  type Craftbook,
  normalizeScriptRefs,
  normalizeStepGate,
} from '../../core/src/browser.js';
import { assertPortableCraftbookSupported } from '../../core/src/runtime/tasks.js';
import { supportsPortableScriptSource } from './portable-script-support.js';

const checks = new Set([
  'minBytes',
  'totalMinBytes',
  'fileCount',
  'cssMinBytes',
  'sniff',
  'jsonPathEquals',
  'csvShape',
  'tableShape',
  'recordSchema',
]);
const scripts = new Set([
  'checkFileExists',
  'checkJsonValid',
  'checkContains',
  'checkWordBand',
  'checkFileMinBytes',
  'checkFileMinLines',
  'checkFileCount',
  'checkOrderedSections',
  'checkTableShape',
  'checkTaskNoteContains',
  'storeRecords',
  'publishCorpusBatches',
]);
// Until catalog content declares a positive mobile capability floor, require
// its authored step policy to explicitly exclude these unavailable domains.
// This deliberately favors a smaller executable catalog over guessing from prose.
const unavailableGroups = [
  'security-intel',
  'image-intel',
  'entity-intel',
  'archives',
  'data-tables',
  'craftbooks',
  'ai-apps',
  'audio',
  'code-execution',
  'browser-automation',
  'git',
  'web',
  'images',
  'videos',
  'role-delegation',
  'role-delegation-escalation',
];
const knownTools = new Set(BUILTIN_TOOLSETS.flatMap((group) => group.tools));

export function supportsPortableContent(
  book: Craftbook,
  availableTools: ReadonlySet<string>,
): boolean {
  try {
    assertPortableCraftbookSupported(book);
  } catch {
    return false;
  }
  const installedScripts = new Set(Object.keys(book.scripts ?? {}));
  const embedded = new Set(
    Object.entries(book.scripts ?? {})
      .filter(([name, source]) => supportsPortableScriptSource(name, source, installedScripts))
      .map(([name]) => name),
  );
  if (embedded.size !== Object.keys(book.scripts ?? {}).length) return false;
  const scriptAvailable = (ref: { scope?: string; name: string }) =>
    ref.scope === 'standard'
      ? scripts.has(ref.name)
      : ref.scope === 'craftbook' && embedded.has(ref.name);
  return book.steps.every((step) => {
    if (
      [...normalizeScriptRefs(step.onEnter), ...normalizeScriptRefs(step.onExit)].some(
        (ref) => !scriptAvailable(ref),
      )
    )
      return false;
    const policy = step.toolPolicy;
    if (!policy) return false;
    if (policy.allowTools) {
      if (policy.allowTools.some((name) => !availableTools.has(name))) return false;
    } else if (unavailableGroups.some((id) => !policy.disallowBuiltinToolsets?.includes(id))) {
      return false;
    }
    const mentionedTools =
      [step.prompt, step.description].join('\n').match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [];
    if (mentionedTools.some((name) => knownTools.has(name) && !availableTools.has(name)))
      return false;
    if (!step.gate) return true;
    const gate = normalizeStepGate(step.gate);
    return (
      !gate.checks?.some((check) => !checks.has(check.kind)) &&
      !gate.scripts?.some((ref) => !scriptAvailable(ref))
    );
  });
}
