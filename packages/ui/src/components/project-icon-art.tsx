import type { ProjectCustomIcon, ProjectIconId } from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { safeSvgImageUrl } from '../safe-svg-image.js';

/** A project's own icon, ready to paint: a mask for a drawn mark, a picture otherwise. */
export interface ProjectIconArt {
  kind: ProjectCustomIcon['kind'];
  url: string;
}

/**
 * One fetch per project and version, shared by every place the icon shows:
 * the rail, the Projects list and the Overview all ask for the same art.
 * `ready` answers a row that mounts later without a frame of the plain mark.
 */
const loads = new Map<string, Promise<ProjectIconArt | null>>();
const ready = new Map<string, ProjectIconArt | null>();

const artKey = (projectId: string, version: string) => `${projectId}\n${version}`;

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('could not read the picture'));
    reader.readAsDataURL(blob);
  });
}

function loadArt(
  projectId: string,
  kind: ProjectCustomIcon['kind'],
  version: string,
): Promise<ProjectIconArt | null> {
  const key = artKey(projectId, version);
  const known = loads.get(key);
  if (known) return known;
  const load = (async (): Promise<ProjectIconArt | null> => {
    try {
      const blob = await api.getProjectIcon(projectId);
      // A drawn mark is sanitized again here and only ever used as an image,
      // so nothing in it can run. A picture is at most 512 KB, so a data URL
      // costs less than tracking an object URL's lifetime across the views.
      const url = kind === 'drawn' ? safeSvgImageUrl(await blob.text()) : await dataUrl(blob);
      return url ? { kind, url } : null;
    } catch {
      return null;
    }
  })();
  loads.set(key, load);
  void load.then((art) => ready.set(key, art));
  return load;
}

/** Forget what was fetched. Tests call this between cases. */
export function resetProjectIconArtCache(): void {
  loads.clear();
  ready.clear();
}

/** The project's own icon art, or null while it loads or when it has none. */
export function useProjectIconArt(
  projectId: string | undefined,
  icon: ProjectCustomIcon | undefined,
): ProjectIconArt | null {
  const kind = icon?.kind;
  const version = icon?.updatedAt;
  const key = projectId && version ? artKey(projectId, version) : '';
  const [art, setArt] = useState<{ key: string; art: ProjectIconArt | null }>(() => ({
    key,
    art: ready.get(key) ?? null,
  }));
  useEffect(() => {
    if (!projectId || !kind || !version) return;
    let alive = true;
    void loadArt(projectId, kind, version).then((loaded) => {
      if (alive) setArt({ key: artKey(projectId, version), art: loaded });
    });
    return () => {
      alive = false;
    };
  }, [projectId, kind, version]);
  if (!key) return null;
  return art.key === key ? art.art : (ready.get(key) ?? null);
}

/**
 * A drawn mark, painted as a silhouette in the current text color. The SVG is
 * only a mask, so the mark takes the theme's ink like the built-in marks do
 * whatever colors the model wrote, and nothing in it can run.
 */
export function ProjectDrawnMark({ url, size }: { url: string; size: number }) {
  const mask = `url("${url}")`;
  return (
    <span
      className="project-icon-drawn"
      style={{ width: size, height: size, maskImage: mask, WebkitMaskImage: mask }}
    />
  );
}

/** The same, from the SVG text a drawing request returned. */
export function ProjectDrawnMarkFromSvg({ svg, size }: { svg: string; size: number }) {
  const url = safeSvgImageUrl(svg);
  return url ? <ProjectDrawnMark url={url} size={size} /> : null;
}

/** The picture types a person may upload as an icon. */
export const PROJECT_ICON_UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/**
 * Scale a picture down to an icon before it is sent: the largest centered
 * square, at most `edge` pixels a side, as a PNG. Redrawing it also leaves
 * behind whatever the file carried besides pixels (a photo's location).
 */
export async function prepareProjectIconImage(file: Blob, edge = 192): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const target = Math.max(1, Math.min(edge, side));
    const canvas = document.createElement('canvas');
    canvas.width = target;
    canvas.height = target;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This picture could not be read.');
    context.imageSmoothingQuality = 'high';
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      target,
      target,
    );
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('This picture could not be read.');
    return blob;
  } finally {
    bitmap.close();
  }
}

/** What each built-in mark is, as the start of a drawing idea. */
const MARK_IDEAS: Readonly<Record<ProjectIconId, string>> = {
  sheet: 'a sheet of paper',
  folder: 'a folder',
  code: 'a pair of code braces',
  branch: 'a branching path',
  envelope: 'an envelope',
  calendar: 'a calendar page',
  bubbles: 'two speech bubbles',
  chart: 'a small bar chart',
  frame: 'a picture frame',
  quill: 'a quill pen',
  sprout: 'a seedling',
  die: 'a die',
  house: 'a little house',
  coin: 'a coin',
  banner: 'a banner on a pole',
  terminal: 'a terminal window',
  globe: 'a globe',
  server: 'a stack of servers',
  package: 'a parcel',
  book: 'an open book',
  palette: 'a paint palette',
  camera: 'a camera',
  briefcase: 'a briefcase',
  heart: 'a heart',
  cards: 'a pair of cards',
  meal: 'a fork and knife',
  plane: 'a paper plane',
  people: 'a ring of small circles',
  dots: 'three dots',
};

/**
 * The description a drawing starts from: what the project is called, what
 * kind it is, and the mark its type gives it as a first idea. The person
 * edits it before anything is drawn.
 */
export function projectIconBrief(project: {
  name: string;
  typeMark: ProjectIconId;
  typeLabel?: string | undefined;
}): string {
  const kind = project.typeLabel?.trim();
  const about = kind ? `“${project.name}”, a ${kind.toLowerCase()} project` : `“${project.name}”`;
  return `Something that stands for ${about}. One idea: ${MARK_IDEAS[project.typeMark]}, with a twist of its own.`;
}
