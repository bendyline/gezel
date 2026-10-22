import { KeyChoice, ToggleKey } from '../KeyChoice.js';

export type DiagramMode = 'overview' | 'focus';
export type DiagramKind = 'code' | 'docs';

const DEPTHS = [0, 1, 2, 3].map((d) => ({ value: d, label: String(d) }));

export interface DiagramToolbarProps {
  mode: DiagramMode;
  onMode: (mode: DiagramMode) => void;
  /** Focus needs a file to center on. */
  canFocus: boolean;
  uses: number;
  usedBy: number;
  onDepth: (uses: number, usedBy: number) => void;
  kind: DiagramKind;
  onKind: (kind: DiagramKind) => void;
  tests: boolean;
  onTests: (on: boolean) => void;
  hideShortcuts: boolean;
  onHideShortcuts: (on: boolean) => void;
  query: string;
  onQuery: (query: string) => void;
  /** Enter in the find box: select the first match. */
  onFind: () => void;
  onFit: () => void;
  onCollapseAll: () => void;
  onReset: () => void;
}

/**
 * The Diagram's controls: what to show, how far a focus reaches, which
 * connections count, and the camera. Keys in trays throughout (ux.md).
 */
export function DiagramToolbar(props: DiagramToolbarProps) {
  const { mode, kind } = props;
  return (
    <div className="diagram-toolbar">
      <KeyChoice
        label="What to show"
        value={mode}
        onChange={props.onMode}
        options={[
          { value: 'overview', label: 'Overview', title: 'The whole project, folder by folder' },
          {
            value: 'focus',
            label: 'Focus',
            disabled: !props.canFocus,
            title: props.canFocus
              ? 'One file, what it uses, and what uses it'
              : 'Select a file to focus on it',
          },
        ]}
      />
      {mode === 'focus' && (
        <>
          <span className="diagram-toolbar-label" aria-hidden="true">
            Uses
          </span>
          <KeyChoice
            label="Steps to follow what it uses"
            value={props.uses}
            onChange={(uses) => props.onDepth(uses, props.usedBy)}
            options={DEPTHS}
          />
          <span className="diagram-toolbar-label" aria-hidden="true">
            Used by
          </span>
          <KeyChoice
            label="Steps to follow what uses it"
            value={props.usedBy}
            onChange={(usedBy) => props.onDepth(props.uses, usedBy)}
            options={DEPTHS}
          />
        </>
      )}
      <KeyChoice
        label="Connections"
        value={kind}
        onChange={props.onKind}
        options={[
          { value: 'code', label: 'Code', title: 'Imports and includes between code files' },
          { value: 'docs', label: 'Documents', title: 'Links between documents' },
        ]}
      />
      {/* biome-ignore lint/a11y/useSemanticElements: a tray of keys, not a form; <fieldset> would bring a legend and form-group styling. */}
      <div className="gz-tray" role="group" aria-label="Filters">
        <ToggleKey
          label="Tests"
          title="Show test files"
          pressed={props.tests}
          onChange={props.onTests}
        />
        <ToggleKey
          label="Hide shortcuts"
          title="Leave out a line when a longer path already shows the connection"
          pressed={props.hideShortcuts}
          onChange={props.onHideShortcuts}
        />
      </div>
      <input
        type="search"
        className="diagram-toolbar-find"
        placeholder="Find a file"
        aria-label="Find a file in the diagram"
        value={props.query}
        onChange={(e) => props.onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            props.onFind();
          }
        }}
      />
      <div className="gz-tray" role="toolbar" aria-label="Diagram view">
        <button
          type="button"
          className="gz-key"
          onClick={props.onFit}
          title="Fit the whole diagram"
        >
          Fit
        </button>
        {mode === 'overview' && (
          <>
            <button
              type="button"
              className="gz-key"
              onClick={props.onCollapseAll}
              title="Close every folder"
            >
              Collapse all
            </button>
            <button
              type="button"
              className="gz-key"
              onClick={props.onReset}
              title="Open folders the way the diagram first did"
            >
              Reset
            </button>
          </>
        )}
      </div>
    </div>
  );
}
