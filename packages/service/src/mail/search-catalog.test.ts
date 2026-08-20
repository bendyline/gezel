/**
 * Mail quick-open entries derived purely from the connector writer's path
 * layout (storage.ts) — no file reads. The parser must accept exactly
 * mail-shaped record paths and reject everything else that shares the
 * corpus tree (attachments, sidecars, other connectors' records).
 */

import { describe, expect, it } from 'vitest';
import { mailCatalogEntries, parseMailPath } from './search-catalog.js';

const MAIL_PATH =
  'data/work-mail/inbox/2026-08-19--quarterly-numbers--1a2b3c4d/001--2026-08-19T14-32--from-alice--deadbeef.md';

describe('parseMailPath', () => {
  it('recovers subject, sender, and date from a record path', () => {
    expect(parseMailPath('p1', MAIL_PATH)).toEqual({
      projectId: 'p1',
      path: MAIL_PATH,
      subject: 'quarterly numbers',
      from: 'alice',
      date: '2026-08-19 14:32',
    });
  });

  it('rejects non-record files that live in the same corpus tree', () => {
    const threadDir = 'data/work-mail/inbox/2026-08-19--quarterly-numbers--1a2b3c4d';
    // Attachment (no seq--iso--from stem), flags sidecar, and a path too
    // shallow to carry a thread dir all stay out of the catalog.
    expect(parseMailPath('p1', `${threadDir}/budget.xlsx`)).toBeNull();
    expect(parseMailPath('p1', 'data/work-mail/inbox/_flags.json')).toBeNull();
    expect(parseMailPath('p1', 'report.md')).toBeNull();
    // A record-shaped file outside a thread-shaped dir is not mail.
    expect(
      parseMailPath('p1', 'data/notes/misc/001--2026-08-19T14-32--from-alice--deadbeef.md'),
    ).toBeNull();
  });

  it('degrades an empty subject slug honestly', () => {
    const path = 'data/m/inbox/2026-08-19----1a2b3c4d/001--2026-08-19T09-05--from-bob--cafebabe.md';
    // The thread-dir regex requires a subject segment; a truly empty slug
    // (double hyphen collapses) may not match — either outcome must not
    // fabricate a subject.
    const parsed = parseMailPath('p1', path);
    if (parsed) expect(parsed.subject).toBe('(no subject)');
  });
});

describe('mailCatalogEntries', () => {
  it('keeps only paths under the mail corpus roots', () => {
    const entries = mailCatalogEntries(
      'p1',
      ['data/work-mail'],
      [
        MAIL_PATH,
        // Same shape, different (non-mail) corpus — must be excluded.
        'data/crm-sync/x/2026-08-19--not-mail--1a2b3c4d/001--2026-08-19T14-32--from-eve--deadbeef.md',
        'reports/summary.md',
      ],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.subject).toBe('quarterly numbers');
  });

  it('returns nothing when the project has no mail bindings', () => {
    expect(mailCatalogEntries('p1', [], [MAIL_PATH])).toEqual([]);
  });
});
