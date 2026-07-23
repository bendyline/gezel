import type { MetaFormValue, ScriptDiagnostic, ScriptMeta } from '@bendyline/gezel';
import {
  formValueToMeta,
  joinMetaRegion,
  metaToFormValue,
  parseMetaObject,
  serializeScriptMeta,
  splitScriptSource,
  stitchScriptSource,
} from '@bendyline/gezel';
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import * as Tabs from '../../primitives/Tabs.js';
import {
  type EditorProblem,
  ScriptCodeEditor,
  type ScriptCodeEditorHandle,
} from './ScriptCodeEditor.js';
import { ScriptMetaForm } from './ScriptMetaForm.js';

/**
 * Two-tab script editor — Script / Properties — sharing one canonical
 * full-source string. The tabs are two lenses over that string:
 *
 *  - **Script** is the full-source Monaco editor with the setup region
 *    (imports + meta statement) collapsed into a folded section — one click to
 *    expand. Feeding it the whole file (not just the body) is what makes
 *    `gezel`, `meta`, and `InferredInput<typeof meta>` resolve, so the body
 *    type-checks and gets real IntelliSense; folding (vs. hiding) keeps line
 *    numbers continuous and select-all normal. It stays authoritative for SDK
 *    IntelliSense, server diagnostics, problem markers, and `revealLine`.
 *  - **Properties** is a squisq form over the `meta` block; edits re-serialize
 *    `export const meta = defineScript({...})` and re-stitch the source.
 *
 * The canonical source is reconciled lazily: edits in either tab update the
 * source immediately (so the parent's dirty/draft/save logic is unaffected), but
 * the other tab's view is refreshed only when switched into. The handle is
 * API-compatible with {@link ScriptCodeEditorHandle} so the host views drop it
 * in with only a ref-type change.
 */

export type { EditorProblem };

export interface ScriptEditorTabsHandle {
  getValue(): string | null;
  setValue(text: string): void;
  revealLine(line: number): void;
  focus(): void;
  setServerDiagnostics(diagnostics: ScriptDiagnostic[]): void;
}

export interface ScriptEditorTabsProps {
  projectId: string;
  scriptName: string;
  initialSource: string;
  /** Server-parsed meta seeds the Properties form without UI-side parsing. */
  initialMeta?: ScriptMeta;
  readOnly?: boolean;
  onChangeContent?: (source: string) => void;
  onSave?: () => void;
  onProblems?: (problems: EditorProblem[]) => void;
  onReady?: () => void;
}

type TabId = 'properties' | 'script';

export const ScriptEditorTabs = forwardRef<ScriptEditorTabsHandle, ScriptEditorTabsProps>(
  function ScriptEditorTabs(
    {
      projectId,
      scriptName,
      initialSource,
      initialMeta,
      readOnly,
      onChangeContent,
      onSave,
      onProblems,
      onReady,
    },
    ref,
  ) {
    const scriptRef = useRef<ScriptCodeEditorHandle | null>(null);

    // Canonical full source + its current split into regions.
    const sourceRef = useRef(initialSource);
    const splitRef = useRef(splitScriptSource(initialSource));

    // Which derived lens needs refreshing from the canonical source on entry.
    const scriptStale = useRef(false);
    const propsStale = useRef(false);
    // Suppress the editor's change handler while we push values programmatically.
    const suppress = useRef(0);

    // Script is the full-source editor and the only place raw text is edited, so
    // it's always the landing tab (Properties is just a lens over the meta block,
    // and is disabled when the meta can't be parsed).
    const [tab, setTab] = useState<TabId>('script');

    // Seeded once at mount; later edits flow through the handle/tab
    // reconciliation, not props.
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally seeded once at mount with empty deps
    const initialForm = useMemo<{ value: MetaFormValue | null; ok: boolean }>(() => {
      if (initialMeta) return { value: metaToFormValue(initialMeta), ok: true };
      const r = parseMetaObject(splitRef.current.metaText);
      return r.ok ? { value: metaToFormValue(r.meta), ok: true } : { value: null, ok: false };
    }, []);

    const [formValue, setFormValue] = useState<MetaFormValue | null>(initialForm.value);
    const [metaParseOk, setMetaParseOk] = useState(initialForm.ok);
    const [formIssues, setFormIssues] = useState<string[]>([]);

    const found = splitRef.current.found;

    // ── Programmatic push into the Monaco model (guarded) ─────────────────
    // The Script editor holds the full canonical source; we re-collapse the
    // setup region after replacing the buffer so only the body shows.
    const pushScript = (full: string) => {
      suppress.current++;
      scriptRef.current?.setValue(full);
      scriptRef.current?.collapsePreamble();
      suppress.current--;
    };

    const refreshForm = () => {
      const r = parseMetaObject(splitRef.current.metaText);
      if (r.ok) {
        setFormValue(metaToFormValue(r.meta));
        setFormIssues([]);
        setMetaParseOk(true);
      } else {
        setMetaParseOk(false);
      }
    };

    // ── Edit handlers ─────────────────────────────────────────────────────
    // The Script editor edits the full source directly; its change carries the
    // whole file, so only the Properties lens needs re-deriving on entry.
    const onScriptChange = (text: string) => {
      if (suppress.current > 0) return;
      sourceRef.current = text;
      splitRef.current = splitScriptSource(text);
      propsStale.current = true;
      onChangeContent?.(text);
    };

    const onFormChange = (next: MetaFormValue) => {
      setFormValue(next);
      const r = formValueToMeta(next);
      if (!r.ok) {
        setFormIssues(r.issues);
        return; // keep the last valid source until the form validates
      }
      setFormIssues([]);
      const metaText = serializeScriptMeta(r.meta);
      splitRef.current = { ...splitRef.current, metaText, found: true };
      const stitched = stitchScriptSource({
        preamble: splitRef.current.preamble,
        metaText: joinMetaRegion(splitRef.current),
        body: splitRef.current.body,
      });
      sourceRef.current = stitched;
      scriptStale.current = true;
      onChangeContent?.(stitched);
    };

    // ── Tab switching: refresh the lens we're entering ────────────────────
    const switchTab = (next: TabId) => {
      if (next === 'script' && scriptStale.current) {
        pushScript(sourceRef.current);
        scriptStale.current = false;
      } else if (next === 'properties' && propsStale.current) {
        refreshForm();
        propsStale.current = false;
      }
      setTab(next);
    };

    // ── Imperative handle (mirrors ScriptCodeEditorHandle) ────────────────
    // biome-ignore lint/correctness/useExhaustiveDependencies: handler closes over `tab` and stable refs; the helper closures are recreated each render and would thrash the handle if listed
    useImperativeHandle(
      ref,
      (): ScriptEditorTabsHandle => ({
        getValue: () => sourceRef.current,
        setValue: (text) => {
          sourceRef.current = text;
          splitRef.current = splitScriptSource(text);
          pushScript(text);
          refreshForm();
          scriptStale.current = false;
          propsStale.current = false;
          // Match ScriptCodeEditor.setValue, whose model change fired onChange;
          // callers pre-set their saved baseline and rely on this to (re)derive
          // dirtiness (e.g. AI-drafted source → dirty=true).
          onChangeContent?.(text);
        },
        revealLine: (line) => {
          // Jump to the code editor first; Monaco unfolds the setup region if
          // the target line lives inside it.
          if (tab !== 'script') switchTab('script');
          scriptRef.current?.revealLine(line);
        },
        focus: () => scriptRef.current?.focus(),
        setServerDiagnostics: (d) => scriptRef.current?.setServerDiagnostics(d),
      }),
      // revealLine reads `tab` to switch into Script first; refs are stable.
      [tab],
    );

    const propsDisabled = !found || !metaParseOk;

    return (
      <div className="script-editor-tabs">
        <Tabs.Root value={tab} onValueChange={(v) => switchTab(v as TabId)}>
          <Tabs.List aria-label="Script editor">
            <Tabs.Trigger value="script">Script</Tabs.Trigger>
            <Tabs.Trigger value="properties" disabled={propsDisabled}>
              Properties
            </Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="script" forceMount className="script-editor-tabs__panel">
            <ScriptCodeEditor
              ref={scriptRef}
              projectId={projectId}
              scriptName={scriptName}
              initialSource={initialSource}
              collapsePreambleOnMount
              readOnly={readOnly}
              onChangeContent={onScriptChange}
              onSave={onSave}
              onProblems={onProblems}
              onReady={onReady}
            />
          </Tabs.Content>

          <Tabs.Content value="properties" forceMount className="script-editor-tabs__panel">
            {propsDisabled || !formValue ? (
              <p className="placeholder small">
                The meta block can't be shown as a form — expand the setup section at the top of the
                Script tab and edit it there.
              </p>
            ) : (
              <ScriptMetaForm
                value={formValue}
                onChange={onFormChange}
                readOnly={readOnly}
                issues={formIssues}
              />
            )}
          </Tabs.Content>
        </Tabs.Root>
      </div>
    );
  },
);
