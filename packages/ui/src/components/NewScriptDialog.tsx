import type { ScriptTemplateId } from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Dialog } from '../primitives/index.js';
import { CapabilityPills } from './CapabilityPills.js';
import { setPendingDraft } from './script-editor/pending-drafts.js';

/**
 * Create-a-script dialog, shared by ScriptsView and the task-step attach
 * flow. Two paths in:
 *   - describe what it should do → "Draft with AI": the script is
 *     created from the blank skeleton immediately (creation never waits
 *     on a model) and the editor drafts into the buffer asynchronously
 *     via the pending-drafts handoff;
 *   - pick a starter template (cards show what each is allowed to do —
 *     no code on the card).
 */

interface TemplateCard {
  id: ScriptTemplateId;
  title: string;
  blurb: string;
  requires: string[];
}

const TEMPLATES: TemplateCard[] = [
  {
    id: 'post-message',
    title: 'Post a message when a phase starts',
    blurb: 'Writes a note onto the task so the team sees it.',
    requires: ['tasks.write'],
  },
  {
    id: 'fetch-and-summarize',
    title: 'Fetch a URL and summarize it',
    blurb: 'Pulls a page and produces a one-paragraph summary.',
    requires: ['network', 'llm'],
  },
  {
    id: 'check-files',
    title: 'Check files and decide',
    blurb: 'Inspects the workspace and outputs a yes/no a phase can advance on.',
    requires: ['workspace.read'],
  },
  {
    id: 'call-tool',
    title: 'Call a tool',
    blurb: 'Runs any registered tool — search, git, GitHub, browser.',
    requires: ['network'],
  },
  {
    id: 'ask-ai',
    title: 'Ask the AI about this task',
    blurb: 'Reads a task and answers a question about it.',
    requires: ['llm', 'tasks.read'],
  },
  {
    id: 'blank',
    title: 'Start blank',
    blurb: 'Just the skeleton every script needs.',
    requires: [],
  },
];

function suggestName(description: string): string {
  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 4);
  const name = words.join('-');
  return /^[a-z]/.test(name) ? name : name ? `do-${name}` : '';
}

export function NewScriptDialog({
  open,
  projectId,
  onClose,
  onCreated,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
  /** Called with the new script's name after it exists on disk. */
  onCreated: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState<ScriptTemplateId>('blank');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName('');
      setNameTouched(false);
      setDescription('');
      setTemplate('blank');
      setBusy(false);
      setError(null);
    }
  }, [open]);

  const effectiveName = nameTouched || name ? name : suggestName(description);
  const nameValid = /^[a-zA-Z][\w-]*$/.test(effectiveName);

  const create = async (withAiDraft: boolean) => {
    if (busy || !nameValid) return;
    setBusy(true);
    setError(null);
    try {
      await api.createProjectScript(projectId, {
        name: effectiveName,
        ...(description.trim() ? { description: description.trim() } : {}),
        // AI drafts start from the blank skeleton; the editor fills it in.
        template: withAiDraft ? 'blank' : template,
      });
      if (withAiDraft && description.trim()) {
        setPendingDraft(`${projectId}/${effectiveName}`, description.trim());
      }
      onCreated(effectiveName);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className="new-script-dialog">
          <Dialog.Title asChild>
            <h3>New script</h3>
          </Dialog.Title>
          <Dialog.Description className="muted small">
            Scripts run automatically when task phases start or finish — or whenever you run them
            yourself.
          </Dialog.Description>

          <label className="new-script-field">
            <span>Describe what it should do (optional)</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="When this phase starts, fetch the PR diff and post a one-paragraph summary…"
              rows={3}
              disabled={busy}
            />
          </label>
          <div className="new-script-ai">
            <button
              type="button"
              className="primary"
              disabled={busy || !description.trim() || !nameValid}
              onClick={() => void create(true)}
            >
              Draft it with AI
            </button>
            <span className="muted small">or pick a starting point:</span>
          </div>

          <div className="new-script-templates" aria-label="Starter template">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={template === t.id}
                className={`new-script-template${template === t.id ? ' active' : ''}`}
                onClick={() => setTemplate(t.id)}
                disabled={busy}
              >
                <strong>{t.title}</strong>
                <span className="muted small">{t.blurb}</span>
                <CapabilityPills requires={t.requires} />
              </button>
            ))}
          </div>

          <label className="new-script-field">
            <span>Name</span>
            <input
              type="text"
              value={effectiveName}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              placeholder="summarize-and-post"
              disabled={busy}
            />
            {effectiveName && !nameValid && (
              <span className="scripts-view__error small">
                Names start with a letter and use only letters, digits, dashes, underscores.
              </span>
            )}
          </label>

          {error && <p className="scripts-view__error">{error}</p>}

          <Dialog.Actions>
            <button type="button" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || !nameValid}
              onClick={() => void create(false)}
            >
              {busy ? 'Creating…' : 'Create'}
            </button>
          </Dialog.Actions>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
