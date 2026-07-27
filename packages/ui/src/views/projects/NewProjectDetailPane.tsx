import type { CatalogItemSummary } from '@bendyline/gezel';
import { initialPoppetjeForGezel } from '@bendyline/gezel';
import { CatalogArtwork } from '../../components/CatalogArtwork.js';
import { Poppetje } from '../../poppetje/index.js';
import {
  ProjectGlyph,
  type ProjectGlyphId,
  type ProjectKindMeta,
  categorizeCatalogType,
  categoryMeta,
} from './new-project-meta.js';

/**
 * Presentational top half of the New Project dialog's right pane: the
 * selected type's art, name, category eyebrow, description, and a
 * "Gezellen and Tools" summary. For catalog types the summary is derived from
 * the manifest's composition (crew gezels render as poppetje headshots,
 * seeded deterministically from the template id — a stable illustration,
 * not the exact figure the created gezel will get). Built-in kinds carry
 * hand-written `give` lines instead.
 *
 * The form fields below this stay in `NewProjectDialog` — they are wired
 * into a dozen pieces of dialog state and moving them would mean a
 * thirty-prop component.
 */

export type PaneSelection =
  | { source: 'builtin'; kind: ProjectKindMeta }
  | { source: 'catalog'; item: CatalogItemSummary };

/** `language-trainer` → `Language Trainer`. */
function prettifyTemplateId(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

export function NewProjectPaneHero({ selection }: { selection: PaneSelection }) {
  const isCatalog = selection.source === 'catalog';
  const manifest = isCatalog ? selection.item.manifest : null;
  const catalogType = manifest?.kind === 'project-type' ? manifest : null;

  const category = isCatalog
    ? categoryMeta(categorizeCatalogType(selection.item))
    : categoryMeta(selection.kind.category);
  const name = isCatalog ? (manifest?.name ?? '') : selection.kind.label;
  const description = isCatalog ? (manifest?.description ?? '') : selection.kind.description;

  const crew = catalogType ? (catalogType.gezels ?? []) : [];
  const rows: { glyph: ProjectGlyphId; text: string }[] = [];
  if (catalogType) {
    const toolCount = (catalogType.tools ?? []).length;
    if (toolCount > 0) rows.push({ glyph: 'code', text: plural(toolCount, 'custom tool') });
    if (catalogType.pages) {
      rows.push({ glyph: 'frame', text: 'Live dashboard in the Output pane' });
    }
    const scheduleCount = (catalogType.schedules ?? []).length;
    if (scheduleCount > 0) {
      rows.push({ glyph: 'calendar', text: plural(scheduleCount, 'scheduled routine') });
    }
    const toolsetCount = (catalogType.toolsets ?? []).length;
    if (toolsetCount > 0) rows.push({ glyph: 'dots', text: plural(toolsetCount, 'toolset') });
    const craftbookCount = (catalogType.craftbooks ?? []).length;
    if (craftbookCount > 0)
      rows.push({ glyph: 'sheet', text: plural(craftbookCount, 'craftbook') });
  }
  const giveLines = isCatalog ? [] : selection.kind.give;
  const hasGive = crew.length > 0 || rows.length > 0 || giveLines.length > 0;

  return (
    <div className="gz-npd-hero">
      <div className="gz-npd-hero-art" aria-hidden="true">
        <CatalogArtwork
          {...(isCatalog && selection.item.iconSvg ? { iconSvg: selection.item.iconSvg } : {})}
          {...(isCatalog && selection.item.logoUrl ? { logoUrl: selection.item.logoUrl } : {})}
          svgClassName="gz-npd-hero-art-svg"
          fallback={
            <ProjectGlyph glyph={isCatalog ? category.glyph : selection.kind.glyph} size={34} />
          }
        />
      </div>
      <p className="gz-npd-hero-eyebrow">{category.label}</p>
      <h4 className="gz-npd-hero-name">{name}</h4>
      <p className="gz-npd-hero-description">{description}</p>
      {hasGive && (
        <div className="gz-npd-give">
          <p className="gz-npd-give-eyebrow">Gezellen and Tools</p>
          {crew.length > 0 && (
            <div className="gz-npd-crew">
              {crew.map((member) => {
                const memberName = prettifyTemplateId(member.templateId);
                return (
                  <figure key={member.templateId} className="gz-npd-crew-member">
                    <span className="gz-npd-crew-figure">
                      <Poppetje
                        poppetje={initialPoppetjeForGezel(member.templateId, memberName)}
                        variant="headshot"
                        size={44}
                      />
                    </span>
                    <figcaption>
                      {memberName}
                      {member.voorman && <span className="gz-npd-crew-voorman">voorman</span>}
                    </figcaption>
                  </figure>
                );
              })}
            </div>
          )}
          <ul className="gz-npd-give-rows">
            {rows.map((row) => (
              <li key={row.text}>
                <ProjectGlyph glyph={row.glyph} size={15} />
                {row.text}
              </li>
            ))}
            {giveLines.map((line) => (
              <li key={line}>
                <ProjectGlyph glyph="sheet" size={15} />
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
