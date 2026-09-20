import type { MobileState } from '@bendyline/gezel/schemas';
import { AreaIcon } from '../../ui/src/components/AreaIcon.js';
import {
  NavigationArea,
  NavigationGroup,
  NavigationHome,
  NavigationItem,
  PrimaryNavigation,
} from '../../ui/src/components/PrimaryNavigation.js';
import { Poppetje } from '../../ui/src/poppetje/Poppetje.js';

export function MobileNavigation({
  state,
  view,
  onOpen,
}: {
  state: MobileState;
  view: 'project' | 'settings';
  onOpen(view: 'project' | 'settings'): void;
}) {
  return (
    <aside className="app-sidebar mobile-primary-navigation" aria-label="Sidebar">
      <PrimaryNavigation touch>
        <NavigationHome onOpen={() => onOpen('project')} />
        <NavigationGroup area="projects" onOpen={() => onOpen('project')}>
          <li>
            <NavigationItem
              label={state.project.name}
              icon={<AreaIcon area="projects" size={18} />}
              active={view === 'project'}
              onOpen={() => onOpen('project')}
            />
          </li>
        </NavigationGroup>
        <NavigationGroup
          area="documents"
          disabled
          unavailableReason="Documents are not available on this device yet."
        />
        <NavigationGroup area="gezels" onOpen={() => onOpen('project')}>
          <li>
            <NavigationItem
              label={state.gezel.name}
              subtitle={state.gezel.role}
              icon={
                <Poppetje
                  poppetje={state.gezel.poppetje}
                  variant="icon"
                  size={24}
                  grainStyle="none"
                  className="mobile-avatar"
                />
              }
              onOpen={() => onOpen('project')}
            />
          </li>
        </NavigationGroup>
        <NavigationArea
          area="settings"
          active={view === 'settings'}
          onOpen={() => onOpen('settings')}
        />
      </PrimaryNavigation>
    </aside>
  );
}
