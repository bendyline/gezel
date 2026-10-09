import {
  isRuntimeTemplateDefault,
  launchFormParamSchema,
  mainContentParamKey,
} from './craftbook-launch.js';
import type { CraftbookTemplateManifest } from './schemas/catalog.js';
import type { Task } from './schemas/task.js';

/** Compatibility for catalogs published before the starter tag. Tags win as a set. */
export const STARTER_CRAFTBOOK_IDS = [
  'research-report',
  'research-to-document',
  'powerpoint-deck',
  'report-pdf',
  'branding-website',
  'narrated-slideshow',
] as const;

type StarterIdentity = { id: string; tags?: readonly string[] };

export function isStarterCraftbook(book: StarterIdentity, useLegacyFallback = false): boolean {
  return (
    book.tags?.includes('starter') === true ||
    (useLegacyFallback && STARTER_CRAFTBOOK_IDS.some((id) => id === book.id))
  );
}

export function starterCraftbookIds(books: readonly StarterIdentity[]): string[] {
  const fallback = !books.some((book) => isStarterCraftbook(book));
  const ids = books.filter((book) => isStarterCraftbook(book, fallback)).map((book) => book.id);
  const rank = (id: string) => {
    const index = STARTER_CRAFTBOOK_IDS.findIndex((seed) => seed === id);
    return index < 0 ? STARTER_CRAFTBOOK_IDS.length : index;
  };
  return ids.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

const STARTER_NAMES: Record<string, string> = {
  'research-report': 'Research report',
  'research-to-document': 'Word document',
  'powerpoint-deck': 'Slide deck',
  'report-pdf': 'PDF report',
  'branding-website': 'Website',
  'narrated-slideshow': 'Animated slideshow',
};

export function planDisplayName(book: { id: string; name: string }): string {
  return STARTER_NAMES[book.id] ?? book.name;
}

/**
 * Old PowerPoint catalogs have an optional raw sourcePath, not a picker.
 * Omit that field until the catalog declares an input; topic and pasted
 * material still work. Never invent an input the service cannot resolve.
 * Required fields are deliberately preserved, even in a same-id custom book.
 */
export function planLaunchFormSchema(
  book: Pick<CraftbookTemplateManifest, 'id' | 'paramSchema'>,
  omitKeys: readonly string[] = [],
): CraftbookTemplateManifest['paramSchema'] {
  const schema = book.paramSchema;
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const props = schema?.properties as
    | Record<string, { input?: unknown; default?: unknown; askUser?: boolean }>
    | undefined;
  const legacySource =
    book.id === 'powerpoint-deck' &&
    props?.sourcePath &&
    !props.sourcePath.input &&
    !required.includes('sourcePath');
  // Only the six legacy starter forms need this compatibility treatment.
  // General plans retain their authored visibility and explicit opt-ins win.
  const derived = STARTER_CRAFTBOOK_IDS.some((id) => id === book.id)
    ? Object.entries(props ?? {})
        .filter(
          ([, property]) => property.askUser !== true && isRuntimeTemplateDefault(property.default),
        )
        .map(([key]) => key)
    : [];
  return launchFormParamSchema(schema, [
    ...omitKeys,
    ...derived,
    ...(legacySource ? ['sourcePath'] : []),
  ]);
}

/** Diagnostic shared by the catalog contract and the audit script. */
export function pathLikeLaunchFields(schema: Record<string, unknown> | undefined): string[] {
  const properties = schema?.properties as Record<string, Record<string, unknown>> | undefined;
  return Object.entries(properties ?? {})
    .filter(([key, property]) => {
      const text = [key.replace(/([a-z])([A-Z])/g, '$1 $2'), property.title, property.description]
        .filter((value) => typeof value === 'string')
        .join(' ');
      return /\b(path|folder|directory|file[ -]?name)\b/i.test(text);
    })
    .map(([key]) => key);
}

export function planBriefLabel(book: Pick<CraftbookTemplateManifest, 'paramSchema'>): string {
  const key = mainContentParamKey(book.paramSchema);
  const props = book.paramSchema?.properties as Record<string, { title?: unknown }> | undefined;
  const label = key ? props?.[key]?.title : undefined;
  return typeof label === 'string' && label.trim() ? label : 'What should this be about?';
}

/** Declared output files, including publishing steps before an ungated Finish. */
export function planOutputSummary(
  book: Pick<CraftbookTemplateManifest, 'steps' | 'paramSchema'>,
): string | null {
  const defaults = book.paramSchema?.properties as
    | Record<string, { default?: unknown }>
    | undefined;
  const resolve = (file: string): string => {
    let result = file;
    for (let pass = 0; pass < 5; pass++) {
      const next = result.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, key: string) => {
        const value = defaults?.[key]?.default;
        return typeof value === 'string' ? value : match;
      });
      if (next === result) break;
      result = next;
    }
    return result;
  };
  const files: string[] = [];
  for (const step of book.steps) {
    if (step.advanceWhen?.file) files.push(resolve(step.advanceWhen.file));
    if (step.gate && 'checks' in step.gate) {
      for (const check of step.gate.checks ?? []) {
        if ('file' in check && typeof check.file === 'string') files.push(resolve(check.file));
      }
    }
  }
  const has = (extension: string) => files.some((file) => file.toLowerCase().endsWith(extension));
  if (has('.pptx')) return 'A slide deck';
  if (has('.docx')) return 'An editable Word document';
  if (has('.pdf')) return 'A PDF report';
  if (has('.mp4') && has('.gif')) return 'A video and animated GIF';
  if (has('.mp4')) return 'A video';
  if (has('.html')) return 'A website';
  if (has('.md')) return 'A written report';
  return null;
}

/**
 * Local elapsed-time samples, grouped by original book identity. Overnight
 * waits, recurring hosts and fanout children are different jobs, not samples
 * of an immediate launch. A later note/edit must not move the finish time.
 */
export function planDurationEstimates(tasks: readonly Task[]): Record<string, number> {
  const samples = new Map<string, number[]>();
  for (const task of tasks) {
    if (
      task.status !== 'complete' ||
      task.nightShift ||
      task.cron ||
      task.spawnsCraftbook ||
      task.parentTaskRef
    )
      continue;
    const end = Math.max(
      ...task.craftbook.steps
        .map((step) => Date.parse(step.completedAt ?? ''))
        .filter(Number.isFinite),
    );
    const duration = end - Date.parse(task.createdAt);
    if (!Number.isFinite(duration) || duration <= 0) continue;
    const id = task.sourceCraftbookIds?.find((source) => source.role === 'main')?.catalogId;
    if (!id) continue;
    const values = samples.get(id) ?? [];
    values.push(duration);
    samples.set(id, values);
  }
  return Object.fromEntries(
    [...samples].map(([id, values]) => {
      values.sort((a, b) => a - b);
      const mid = Math.floor(values.length / 2);
      return [id, values.length % 2 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2];
    }),
  );
}
