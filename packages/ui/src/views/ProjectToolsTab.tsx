import './ProjectToolsTab.css';
import type { ProjectApprovalsResponse, ProjectDetail } from '@bendyline/gezel';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * The project Tools tab: npm packages installed in the workspace, the
 * `package.json` scripts a gezel may ask to run, and the answers the user
 * gave when a gezel asked. The tab's value (`packages`) and its visibility
 * key (`approvals`) are persisted names and predate the Tools label.
 */

type Decision = 'approved' | 'declined' | 'shipped';

const DECISION_BADGES: Record<Decision, { label: string; tone: 'ok' | 'info' | 'warn' }> = {
  approved: { label: 'Approved', tone: 'ok' },
  shipped: { label: 'Allowed by default', tone: 'info' },
  declined: { label: 'Declined', tone: 'warn' },
};

interface DecisionRow {
  name: string;
  version?: string;
  decision: Decision;
}

function DecisionList({ rows, empty }: { rows: DecisionRow[]; empty: string }) {
  if (rows.length === 0) return <p className="project-tools-empty">{empty}</p>;
  return (
    <ul className="project-tools-list">
      {rows.map((row) => {
        const badge = DECISION_BADGES[row.decision];
        return (
          <li key={`${row.name}@${row.version ?? ''}`} className="project-tools-row">
            <span className="project-tools-name">{row.name}</span>
            {row.version && <code className="project-tools-version">{row.version}</code>}
            <span className={`gz-status-pill gz-status-pill--${badge.tone} project-tools-badge`}>
              {badge.label}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function recordRows(record: Record<string, 'approved' | 'declined'> | undefined): DecisionRow[] {
  return Object.entries(record ?? {}).map(([name, decision]) => ({ name, decision }));
}

export interface ProjectToolsTabProps {
  project: ProjectDetail;
  onProjectChange: (project: ProjectDetail) => void;
}

export function ProjectToolsTab({ project, onProjectChange }: ProjectToolsTabProps) {
  const [pkgName, setPkgName] = useState('');
  const [installing, setInstalling] = useState(false);
  const [log, setLog] = useState('');
  const [packageScripts, setPackageScripts] = useState<Record<string, string>>({});
  const [approvals, setApprovals] = useState<ProjectApprovalsResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listPackageScripts(project.id)
      .then((res) => {
        if (!cancelled) setPackageScripts(res.scripts);
      })
      .catch((err) => {
        console.warn('[ProjectToolsTab] listPackageScripts failed', err);
        if (!cancelled) setPackageScripts({});
      });
    api
      .getProjectApprovals(project.id)
      .then((res) => {
        if (!cancelled) setApprovals(res);
      })
      .catch((err) => {
        console.warn('[ProjectToolsTab] getProjectApprovals failed', err);
        if (!cancelled) setApprovals(null);
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  const install = useCallback(async () => {
    const name = pkgName.trim();
    if (!name || installing) return;
    setInstalling(true);
    setLog('Installing…');
    try {
      const res = await api.installPackage(project.id, { name });
      setLog(res.log);
      onProjectChange(res.project);
      setPkgName('');
    } catch (err) {
      setLog((err as Error).message);
    } finally {
      setInstalling(false);
    }
  }, [installing, onProjectChange, pkgName, project.id]);

  const scripts = Object.entries(packageScripts);
  const npmRows: DecisionRow[] = [
    ...(approvals?.npmApproved ?? []).map((p) => ({
      name: p.package,
      version: p.version,
      decision: (p.approvedBy === 'shipped' ? 'shipped' : 'approved') as Decision,
    })),
    ...(approvals?.npmDeclined ?? []).map((p) => ({
      name: p.package,
      version: p.version,
      decision: 'declined' as Decision,
    })),
  ];
  const scriptRows = recordRows(approvals?.scriptApprovals);
  const npxRows = recordRows(approvals?.npxApprovals);

  return (
    <div className="project-tools">
      <p className="project-tools-lede">
        The packages and scripts your gezels can use in this project. A gezel asks before it
        installs a package or runs a script for the first time, and your answer is remembered here.
      </p>

      <section className="project-tools-section" aria-labelledby="project-tools-packages">
        <h3 id="project-tools-packages" className="project-tools-title">
          Packages
        </h3>
        <form
          className="new-row project-tools-install"
          onSubmit={(e) => {
            e.preventDefault();
            void install();
          }}
        >
          <input
            aria-label="npm package to install"
            placeholder="npm package name"
            value={pkgName}
            onChange={(e) => setPkgName(e.target.value)}
          />
          <button type="submit" disabled={installing || !pkgName.trim()}>
            {installing ? 'Installing…' : 'Install'}
          </button>
        </form>
        {log && <pre className="log project-tools-log">{log}</pre>}
        {project.packages.length > 0 ? (
          <ul className="project-tools-list">
            {project.packages.map((p) => (
              <li key={p.name} className="project-tools-row">
                <span className="project-tools-name">{p.name}</span>
                <code className="project-tools-version">{p.version}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="project-tools-empty">
            No packages installed in this project's workspace yet.
          </p>
        )}
      </section>

      <section className="project-tools-section" aria-labelledby="project-tools-scripts">
        <h3 id="project-tools-scripts" className="project-tools-title">
          Scripts
        </h3>
        <p className="project-tools-hint">
          Defined in the workspace's <code>package.json</code>. A gezel can ask to run any of these.
        </p>
        {scripts.length > 0 ? (
          <ul className="project-tools-list">
            {scripts.map(([name, body]) => (
              <li key={name} className="project-tools-row project-tools-row--script">
                <span className="project-tools-name">{name}</span>
                <code className="project-tools-command">{body}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="project-tools-empty">No scripts defined in package.json.</p>
        )}
      </section>

      <section className="project-tools-section" aria-labelledby="project-tools-approvals">
        <h3 id="project-tools-approvals" className="project-tools-title">
          Approvals
        </h3>
        <p className="project-tools-hint">
          What you answered when a gezel asked. Anything approved runs without asking again.
        </p>
        <h4 className="project-tools-subtitle">npm packages</h4>
        <DecisionList rows={npmRows} empty="No npm packages approved for this project yet." />
        <h4 className="project-tools-subtitle">Scripts</h4>
        <DecisionList rows={scriptRows} empty="No script approvals yet." />
        {npxRows.length > 0 && (
          <>
            <h4 className="project-tools-subtitle">npx commands</h4>
            <DecisionList rows={npxRows} empty="" />
          </>
        )}
      </section>
    </div>
  );
}
