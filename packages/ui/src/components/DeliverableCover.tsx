import type { TaskDeliverable } from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { plainInlineMarkdown } from './plain-markdown.js';

/** Formats a cover can be drawn for from the file's own text. */
export function hasTextCover(path: string): boolean {
  return /\.(md|markdown|txt)$/i.test(path);
}

interface CoverText {
  title: string | null;
  lines: string[];
}

/**
 * The first page of a written deliverable, as a cover on the finished-work
 * card: its heading and opening lines in the reading face. A file name in a
 * tile told the person nothing about what had been made for them.
 */
export function readCoverText(markdown: string): CoverText {
  const body = markdown
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
  let title: string | null = null;
  const lines: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || isMarkupOnly(line)) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading && title === null && lines.length === 0) {
      title = plainInlineMarkdown(heading[1]!);
      continue;
    }
    const plain = plainInlineMarkdown(
      tableRowText(line) ??
        line
          .replace(/^>\s*/, '')
          .replace(/^#{1,6}\s+/, '')
          .replace(/^[-*+]\s+(?:\[[ xX]\]\s+)?/, '• ')
          .replace(/^\d+[.)]\s+/, ''),
    );
    if (plain && plain !== '•') lines.push(plain);
    if (lines.length >= 6) break;
  }
  return { title, lines };
}

/**
 * A line that is only structure: a rule (`---`), a table's divider row
 * (`|---|:--|`), or a picture. A cleaning checklist's cover showed a row of
 * dashes and `| Day | Primary Focus Areas |` with its pipes (2026-11-09).
 */
function isMarkupOnly(line: string): boolean {
  return (
    /^([-*_])(\s*\1){2,}$/.test(line) ||
    /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line) ||
    /^!\[[^\]]*\]\([^)]*\)$/.test(line)
  );
}

/** A table row as its cells: `| Monday | Ovens |` → "Monday · Ovens". */
function tableRowText(line: string): string | null {
  if (!line.startsWith('|')) return null;
  const cells = line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
    .filter(Boolean);
  return cells.join(' · ');
}

export function DeliverableCover({
  deliverable,
  projectId,
}: {
  deliverable: TaskDeliverable;
  projectId: string;
}) {
  const [cover, setCover] = useState<CoverText | null>(null);
  useEffect(() => {
    let cancelled = false;
    const read =
      deliverable.kind === 'artifact'
        ? api.readProjectArtifact(projectId, deliverable.path)
        : api.readProjectWorkspaceFile(projectId, deliverable.path);
    read
      .then((file) => {
        if (!cancelled) setCover(readCoverText(file.content));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [deliverable.kind, deliverable.path, projectId]);
  if (!cover || (!cover.title && cover.lines.length === 0)) return null;
  return (
    <span className="deliverable-cover" aria-hidden="true">
      {cover.title && <span className="deliverable-cover-title">{cover.title}</span>}
      {cover.lines.map((line, index) => (
        // Lines repeat ("• Pack sunscreen" twice) and never reorder.
        // biome-ignore lint/suspicious/noArrayIndexKey: static, ordered excerpt
        <span key={index} className="deliverable-cover-line">
          {line}
        </span>
      ))}
    </span>
  );
}
