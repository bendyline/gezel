import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gildeDataDir } from '@bendyline/gezel-catalog';
import type { CraftbookTemplateSummary } from './types.ts';

const CATALOG_INDEX_PATH = join(gildeDataDir(), 'craftbook-templates', 'index.json');

interface CatalogIndexFile {
  entries: Array<{
    manifest: CraftbookTemplateSummary;
  }>;
}

export async function loadCraftbookTemplates(): Promise<CraftbookTemplateSummary[]> {
  const raw = await readFile(CATALOG_INDEX_PATH, 'utf8');
  const parsed = JSON.parse(raw) as CatalogIndexFile;
  return parsed.entries.map((entry) => entry.manifest).sort((a, b) => a.id.localeCompare(b.id));
}

export async function loadCraftbookTemplateMap(): Promise<Map<string, CraftbookTemplateSummary>> {
  const templates = await loadCraftbookTemplates();
  return new Map(templates.map((template) => [template.id, template]));
}
