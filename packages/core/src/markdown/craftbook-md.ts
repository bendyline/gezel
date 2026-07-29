import matter from 'gray-matter';
import type { CraftbookDoc, CraftbookDocError } from '../schemas/craftbook-doc.js';
import type { NewCraftbookStep } from '../schemas/craftbook.js';
import { slugifyStepId } from '../schemas/craftbook.js';
import {
  FENCE,
  extractFirstFence,
  isFenceClose,
  parseYamlBlock,
  pickFence,
  splitSections,
  stringifyYamlBlock,
} from './md-structure.js';

/**
 * ─ Markdown craftbook document ───────────────────────────────────────
 *
 * The markdown encoding of a {@link CraftbookDoc} (format candidate B of
 * the craftbook-format A/B). One file carries the whole book:
 *
 * ```markdown
 * ---
 * name: Scrape prices
 * entry: fetch
 * triggers: ["scrape prices"]
 * ---
 *
 * Description prose (everything before the first `## ` heading).
 *
 * ## Step: Fetch data
 *
 * ```yaml
 * id: fetch
 * deliverable: { path: prices.csv, kind: data-file }
 * next: report
 * ```
 *
 * Prompt prose for the step.
 *
 * ## Script: pull
 *
 * ```ts
 * import { defineScript, gezel } from '@bendyline/gezel-sdk';
 * …
 * ```
 * ```
 *
 * Section headings are explicit (`## Step: <name>` / `## Script: <name>`)
 * rather than positional so a small model can't mis-nest them, and the
 * step's structured fields ride in ONE fenced yaml block (fences survive
 * small-model generation far better than indented bullet grammars). The
 * yaml is parsed with gray-matter's engine — already a core dependency —
 * so flow-style JSON values are legal too.
 *
 * Round-trip invariant: `parse(serialize(doc))` is deep-equal to `doc`
 * for any schema-valid doc. Load-bearing for the format A/B eval and the
 * catalog migration.
 */

const STEP_HEADING = /^##\s+step\s*:\s*(.+?)\s*$/i;
const SCRIPT_HEADING = /^##\s+script\s*:\s*(.+?)\s*$/i;

/** Frontmatter keys, in serialization order. `entry` is the friendly alias for entryStepId. */
const FRONTMATTER_KEYS = [
  'id',
  'name',
  'entry',
  'basedOn',
  'triggers',
  'command',
  'plan',
  'defaultAssignee',
  'requirements',
  'runModes',
  'toolsets',
  'paramSchema',
  'hooks',
  'version',
  'releasedAt',
] as const;

/** Step-fence keys, in serialization order. Everything except name/prompt (heading + prose). */
const STEP_FENCE_KEYS = [
  'id',
  'description',
  'suggestedGezelId',
  'suggestedRole',
  'capabilityFloor',
  'assignee',
  'deliverable',
  'onEnter',
  'onExit',
  'advanceWhen',
  'gate',
  'next',
  'branches',
  'terminal',
] as const;

export interface CraftbookMarkdownParse {
  ok: boolean;
  doc?: Record<string, unknown>;
  errors: CraftbookDocError[];
}

/**
 * Parse markdown into the RAW doc object (not yet schema-validated — the
 * caller runs `CraftbookDocSchema.parse` so both encodings share one
 * validation + error pipeline). Structural problems (bad frontmatter, a
 * step block that doesn't parse, a script section without a fence) are
 * reported here with the section heading as the location.
 */
export function parseCraftbookMarkdown(text: string): CraftbookMarkdownParse {
  const errors: CraftbookDocError[] = [];
  let fm: Record<string, unknown>;
  let content: string;
  try {
    const parsed = matter(text);
    fm = parsed.data as Record<string, unknown>;
    content = parsed.content;
  } catch (err) {
    return {
      ok: false,
      errors: [
        {
          where: 'frontmatter',
          message: `the YAML frontmatter does not parse: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
          fix: 'check indentation and quoting between the opening and closing --- lines',
        },
      ],
    };
  }

  const lines = content.split(/\r?\n/);
  const sections = splitSections(lines);

  const doc: Record<string, unknown> = {};
  for (const key of FRONTMATTER_KEYS) {
    if (fm[key] !== undefined && fm[key] !== null) {
      doc[key === 'entry' ? 'entryStepId' : key] = fm[key];
    }
  }
  // Unknown frontmatter keys are reported (they're usually a misplaced
  // step field), not silently dropped.
  for (const key of Object.keys(fm)) {
    if (!(FRONTMATTER_KEYS as readonly string[]).includes(key)) {
      errors.push({
        where: 'frontmatter',
        message: `unknown key "${key}".`,
        fix: `legal keys: ${FRONTMATTER_KEYS.join(', ')} — step fields go in the step's yaml block`,
      });
    }
  }

  if (sections.preamble.trim().length > 0) doc.description = sections.preamble.trim();

  const steps: NewCraftbookStep[] = [];
  const scripts: Record<string, string> = {};

  for (const section of sections.sections) {
    const stepMatch = STEP_HEADING.exec(section.heading);
    const scriptMatch = SCRIPT_HEADING.exec(section.heading);
    if (stepMatch) {
      const name = stepMatch[1]!;
      const { fenced, prose, fenceError } = extractStepSection(section.body);
      let fields: Record<string, unknown> = {};
      if (fenceError) {
        errors.push({
          where: `section "## Step: ${name}"`,
          message: fenceError,
          fix: "put the step's structured fields in one ```yaml fence directly under the heading",
        });
      } else if (fenced !== undefined) {
        try {
          fields = parseYamlBlock(fenced);
        } catch (err) {
          errors.push({
            where: `section "## Step: ${name}"`,
            message: `the yaml step block does not parse: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
            fix: 'check indentation/quoting inside the ```yaml fence — flow-style JSON values are also legal',
          });
        }
      }
      const step: Record<string, unknown> = { ...fields, name };
      if (prose.trim().length > 0) step.prompt = prose.trim();
      steps.push(step as NewCraftbookStep);
    } else if (scriptMatch) {
      const name = scriptMatch[1]!;
      const source = extractFirstFence(section.body);
      if (source === undefined) {
        errors.push({
          where: `section "## Script: ${name}"`,
          message: 'no fenced code block found under this heading.',
          fix: 'put the script source in one ```ts fence directly under the heading',
        });
      } else {
        scripts[name] = source;
      }
    } else {
      errors.push({
        where: `section "${section.heading}"`,
        message: 'unrecognized section heading.',
        fix: 'every `## ` heading must be `## Step: <name>` or `## Script: <name>`',
      });
    }
  }

  if (steps.length > 0) doc.steps = steps;
  if (Object.keys(scripts).length > 0) doc.scripts = scripts;

  if (steps.length === 0) {
    errors.push({
      where: 'document',
      message: 'no steps found.',
      fix: 'add at least one `## Step: <name>` section',
    });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, doc, errors: [] };
}

/** Serialize a schema-valid doc to the markdown encoding. */
export function serializeCraftbookMarkdown(doc: CraftbookDoc): string {
  const fm: Record<string, unknown> = {};
  for (const key of FRONTMATTER_KEYS) {
    const docKey = key === 'entry' ? 'entryStepId' : key;
    const value = (doc as Record<string, unknown>)[docKey];
    if (value !== undefined) fm[key] = value;
  }

  const parts: string[] = [];
  if (doc.description) parts.push(doc.description.trim());

  for (const step of doc.steps) {
    const fields: Record<string, unknown> = {};
    for (const key of STEP_FENCE_KEYS) {
      const value = (step as Record<string, unknown>)[key];
      if (value !== undefined) fields[key] = value;
    }
    let section = `## Step: ${step.name}`;
    if (Object.keys(fields).length > 0) {
      section += `\n\n\`\`\`yaml\n${stringifyYamlBlock(fields)}\`\`\``;
    }
    if (step.prompt) section += `\n\n${step.prompt.trim()}`;
    parts.push(section);
  }

  for (const [name, source] of Object.entries(doc.scripts ?? {})) {
    const fence = pickFence(source);
    parts.push(`## Script: ${name}\n\n${fence}ts\n${source.trimEnd()}\n${fence}`);
  }

  const body = `${parts.join('\n\n')}\n`;
  return Object.keys(fm).length > 0 ? matter.stringify(body, fm) : body;
}

/* ─────────────────────────── internals ──────────────────────────────── */
/* Fence machinery (splitSections, extractFirstFence, isFenceClose, yaml
 * block helpers, pickFence) lives in md-structure.ts — shared with the
 * skill-document parser. Only the codec-specific step-section splitter
 * stays here. */

/**
 * From a step section's body: the first fenced block tagged `yaml` (or
 * untagged) is the structured fields; everything else is prompt prose.
 */
function extractStepSection(body: string): {
  fenced?: string;
  prose: string;
  fenceError?: string;
} {
  const lines = body.split('\n');
  const proseLines: string[] = [];
  let fenced: string[] | null = null;
  let inFence = false;
  let fenceTag = '';
  let taken = false;
  let fenceMarker = '';

  for (const line of lines) {
    const fence = FENCE.exec(line);
    if (fence && !inFence) {
      inFence = true;
      fenceMarker = fence[1]!;
      fenceTag = fence[2]!.trim().toLowerCase();
      if (!taken && (fenceTag === 'yaml' || fenceTag === 'yml' || fenceTag === '')) {
        fenced = [];
      } else {
        proseLines.push(line);
      }
      continue;
    }
    if (inFence && isFenceClose(line, fenceMarker)) {
      inFence = false;
      if (fenced !== null && !taken) {
        taken = true;
      } else {
        proseLines.push(line);
      }
      continue;
    }
    if (inFence && fenced !== null && !taken) {
      fenced.push(line);
      continue;
    }
    proseLines.push(line);
  }
  if (inFence) {
    return { prose: proseLines.join('\n'), fenceError: 'a code fence is never closed.' };
  }
  return {
    ...(taken && fenced !== null ? { fenced: fenced.join('\n') } : {}),
    prose: proseLines.join('\n'),
  };
}

/** Default step id used by both codecs when a step block omits `id`. */
export function defaultStepIdForName(name: string): string {
  return slugifyStepId(name);
}
