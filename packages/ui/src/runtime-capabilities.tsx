import {
  DESKTOP_RUNTIME_CAPABILITIES,
  type RecentTab,
  type RecentTabArea,
  type RuntimeCapabilities,
} from '@bendyline/gezel';

export function runtimeCapabilities(): Readonly<RuntimeCapabilities> {
  return window.__GEZEL__?.capabilities ?? DESKTOP_RUNTIME_CAPABILITIES;
}

export function supportsArea(area: RecentTabArea): boolean {
  const caps = runtimeCapabilities();
  switch (area) {
    case 'projects':
      return caps.projects;
    case 'gezels':
      return caps.gezels;
    case 'documents':
      return caps.documents;
    case 'tasks':
      return caps.tasks;
    case 'craftbooks':
      return caps.catalog && caps.tasks;
    case 'scripts':
      return caps.scripts;
    case 'history':
      return caps.background;
    case 'knowledge':
      return caps.knowledge;
    case 'benchmarks':
      return caps.daemonSettings;
    case 'settings':
      return caps.modelSettings;
    case 'handboek':
      return caps.catalog;
  }
}

export function supportsTab(tab: RecentTab): boolean {
  switch (tab.kind) {
    case 'area':
      return supportsArea(tab.area);
    case 'project':
      return runtimeCapabilities().projects;
    case 'gezel':
      return runtimeCapabilities().gezels;
    case 'document':
      return runtimeCapabilities().documents;
    case 'task':
      return runtimeCapabilities().tasks;
    case 'script':
      return runtimeCapabilities().scripts;
    case 'craftbook':
      return runtimeCapabilities().catalog && runtimeCapabilities().tasks;
    case 'craftbook-script':
      return runtimeCapabilities().catalog && runtimeCapabilities().scripts;
  }
}

export function CapabilityUnavailable({ feature }: { feature: string }) {
  return (
    <section className="placeholder" aria-live="polite">
      <h2>{feature}</h2>
      <p>This feature is not available with the current runtime.</p>
    </section>
  );
}
