import type { CatalogItemSummary } from '@bendyline/gezel';
import {
  catalogGroundFor,
  initialPoppetjeForGezel,
  isLegacyRoleTitle,
  plainRoleTitle,
} from '@bendyline/gezel';
import { CatalogArtwork } from '../../components/CatalogArtwork.js';
import { Poppetje } from '../../poppetje/index.js';
import { runtimeCapabilities } from '../../runtime-capabilities.js';
import {
  ProjectGlyph,
  type ProjectGlyphId,
  type ProjectKindMeta,
  catalogProjectTypeGlyph,
  categorizeCatalogType,
  categoryMeta,
} from './new-project-meta.js';

/**
 * Presentational pieces for step 2 of the New Project dialog: the selected
 * starting point's art and name (header), and its brief — the description
 * plus a "Gezellen and Tools" summary of what the project arrives with.
 * For catalog types the summary is derived from the manifest's composition
 * (crew gezels render as poppetje headshots, seeded deterministically from
 * the template id — a stable illustration, not the exact figure the created
 * gezel will get). Built-in kinds carry hand-written `give` lines instead.
 *
 * The form fields stay in `NewProjectDialog` — they are wired into a dozen
 * pieces of dialog state and moving them would mean a thirty-prop component.
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

function catalogTypeOf(selection: PaneSelection) {
  if (selection.source !== 'catalog') return null;
  const manifest = selection.item.manifest;
  return manifest.kind === 'project-type' ? manifest : null;
}

/** Name + category eyebrow for the step-2 header. */
export function selectionIdentity(selection: PaneSelection): {
  name: string;
  categoryLabel: string;
  description: string;
} {
  if (selection.source === 'catalog') {
    const manifest = selection.item.manifest;
    return {
      name: manifest.name,
      categoryLabel: categoryMeta(categorizeCatalogType(selection.item)).label,
      description: manifest.description,
    };
  }
  return {
    name: selection.kind.label,
    categoryLabel: categoryMeta(selection.kind.category).label,
    description: selection.kind.description,
  };
}

/**
 * The selection's artwork, sized by the tile it sits in. A catalog type's
 * shipped mark wins, painted on its category ground; its `icon` glyph is the
 * fallback, matching the gallery card.
 */
export function SelectionArt({
  selection,
  size,
}: {
  selection: PaneSelection;
  size: number;
}) {
  return (
    <CatalogArtwork
      {...(selection.source === 'catalog' && selection.item.iconSvg
        ? { iconSvg: selection.item.iconSvg }
        : {})}
      {...(selection.source === 'catalog' && selection.item.logoUrl
        ? { logoUrl: selection.item.logoUrl }
        : {})}
      ground={
        selection.source === 'catalog' ? catalogGroundFor(selection.item.manifest) : undefined
      }
      svgClassName="gz-npd-hero-art-svg"
      fallback={
        <ProjectGlyph
          glyph={
            selection.source === 'catalog'
              ? catalogProjectTypeGlyph(selection.item)
              : selection.kind.glyph
          }
          size={size}
        />
      }
    />
  );
}

/**
 * What this starting point is, and what it brings — the left column of step
 * 2. A project type's crew and tooling are the reason a person picks it, so
 * they get the reading width rather than a 19rem pane's five-line clamp.
 */
export function NewProjectBrief({ selection }: { selection: PaneSelection }) {
  const catalogType = catalogTypeOf(selection);
  const { description } = selectionIdentity(selection);

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
      // A host that runs nothing while it is closed must not promise a routine.
      const runsHere = runtimeCapabilities().background;
      rows.push({
        glyph: 'calendar',
        text: `${plural(scheduleCount, 'scheduled routine')}${runsHere ? '' : ', run by the desktop app'}`,
      });
    }
    const toolsetCount = (catalogType.toolsets ?? []).length;
    if (toolsetCount > 0) rows.push({ glyph: 'dots', text: plural(toolsetCount, 'toolset') });
    const craftbookCount = (catalogType.craftbooks ?? []).length;
    if (craftbookCount > 0)
      rows.push({ glyph: 'sheet', text: plural(craftbookCount, 'craftbook') });
  }
  const giveLines = selection.source === 'builtin' ? selection.kind.give : [];
  const hasGive = crew.length > 0 || rows.length > 0 || giveLines.length > 0;

  return (
    <>
      <p className="gz-npd-brief-lede">{description}</p>
      {hasGive && (
        <div className="gz-npd-give">
          <p className="gz-npd-give-eyebrow">Gezellen and Tools</p>
          {crew.length > 0 && (
            <div className="gz-npd-crew">
              {crew.map((member) => {
                const memberName = prettifyTemplateId(member.templateId);
                // Crew template ids can still be Dutch titles (`reisleider`);
                // the caption reads in plain English, the figure stays seeded
                // as before.
                const memberTitle = isLegacyRoleTitle(member.templateId)
                  ? plainRoleTitle(member.templateId)
                  : memberName;
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
                      {memberTitle}
                      {member.voorman && <span className="gz-npd-crew-voorman">crew lead</span>}
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
    </>
  );
}
