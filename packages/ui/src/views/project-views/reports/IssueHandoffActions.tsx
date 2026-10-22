import { useRef, useState } from 'react';
import { api } from '../../../api.js';
import { downloadBlob } from '../../../components/DocumentExport/download-blob.js';

/**
 * The handoff report's keys: copy it or save it for a coding app that has no
 * Gezel tools, and import the answers once the app has filled it in. Saving
 * is the person's own download; Gezel never writes into their folder.
 */
export function IssueHandoffActions({
  projectId,
  path,
  onImported,
}: {
  projectId: string;
  path: string;
  onImported: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const read = async () => (await api.readProjectArtifact(projectId, path)).content;

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setNote(null);
    try {
      setNote(await fn());
    } catch (e: unknown) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const importFile = (file: File) =>
    run(async () => {
      const res = await api.issueTriage.importVerdicts(projectId, { markdown: await file.text() });
      onImported();
      if (res.applied === 0 && res.refused === 0) {
        return 'No answers found in that file. Fill in the Verdict line under an issue first.';
      }
      const parts = [`${res.applied} answer${res.applied === 1 ? '' : 's'} imported`];
      if (res.refused > 0) parts.push(`${res.refused} not applied`);
      if (res.skipped.length > 0) parts.push(`${res.skipped.length} left empty`);
      const refusals = res.results.filter((r) => r.outcome === 'refused').map((r) => r.message);
      return `${parts.join(', ')}.${refusals.length > 0 ? ` ${refusals.slice(0, 3).join(' ')}` : ''}`;
    });

  return (
    <div className="issue-handoff-actions">
      <div className="gz-tray" role="group" aria-label="Issues for review">
        <button
          type="button"
          className="gz-key"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await navigator.clipboard.writeText(await read());
              return 'Copied. Paste it into your coding app and ask it to fill in each answer.';
            })
          }
        >
          Copy
        </button>
        <button
          type="button"
          className="gz-key"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              downloadBlob(new Blob([await read()], { type: 'text/markdown' }), 'issue-handoff.md');
              return null;
            })
          }
        >
          Save…
        </button>
        <button
          type="button"
          className="gz-key"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          Import answers…
        </button>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept=".md,text/markdown,text/plain"
        hidden
        aria-label="Answered handoff document"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void importFile(file);
        }}
      />
      {note && (
        <p className="reports-view-note" role="status">
          {note}
        </p>
      )}
    </div>
  );
}
