import type { RecentTabArea } from '@bendyline/gezel';
import type { ButtonHTMLAttributes, HTMLAttributes, ReactElement, ReactNode } from 'react';
import { AreaIcon } from './AreaIcon.js';
import '../styles/primary-navigation.css';

export const NAVIGATION_AREA_LABELS: Record<RecentTabArea, string> = {
  projects: 'Projects',
  gezels: 'Gezellen',
  documents: 'Documents',
  tasks: 'Tasks',
  craftbooks: 'Craftbooks',
  scripts: 'Scripts',
  history: 'History',
  handboek: 'Handboek',
  knowledge: 'Knowledge',
  benchmarks: 'Benchmarks',
  settings: 'Settings',
};

/** Shared navigation presentation; hosts own entities, capabilities and routing. */
export function PrimaryNavigation({
  children,
  className = '',
  touch = false,
  ...props
}: HTMLAttributes<HTMLElement> & { touch?: boolean }) {
  return (
    <nav
      aria-label="Primary navigation"
      {...props}
      className={`app-sidebar-scroll${touch ? ' primary-navigation-touch' : ''}${className ? ` ${className}` : ''}`}
    >
      {children}
    </nav>
  );
}

interface NavigationItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  label: ReactNode;
  icon: ReactNode;
  active?: boolean;
  subtitle?: ReactNode;
  root?: boolean;
  onOpen?: () => void;
  onPreload?: () => void;
}

export function NavigationItem({
  label,
  icon,
  active = false,
  subtitle,
  root = false,
  onOpen,
  onPreload,
  className = '',
  ...props
}: NavigationItemProps) {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={onOpen}
      onPointerEnter={onPreload}
      onFocus={onPreload}
      onPointerDown={onPreload}
      {...props}
      className={`app-sidebar-item ${root ? 'app-sidebar-item-root' : 'app-sidebar-subitem'}${active ? ' active' : ''}${className ? ` ${className}` : ''}`}
    >
      <span className="app-sidebar-item-icon">{icon}</span>
      {subtitle ? (
        <span className="app-sidebar-gezel-text">
          <span className="app-sidebar-item-label">{label}</span>
          <span className="app-sidebar-item-role">{subtitle}</span>
        </span>
      ) : (
        <span className="app-sidebar-item-label">{label}</span>
      )}
    </button>
  );
}

export function NavigationHome({
  label = 'Home',
  ...props
}: Omit<NavigationItemProps, 'icon' | 'root' | 'label'> & { label?: ReactNode }) {
  return (
    <NavigationItem
      title="Home"
      data-testid="sidebar-meester"
      {...props}
      label={label}
      icon={<HomeIcon />}
      root
      className={`app-sidebar-home${props.className ? ` ${props.className}` : ''}`}
    />
  );
}

export function NavigationArea({
  area,
  ...props
}: Omit<NavigationItemProps, 'icon' | 'label' | 'root'> & { area: RecentTabArea }) {
  return (
    <NavigationItem
      title={NAVIGATION_AREA_LABELS[area]}
      data-testid={`sidebar-area-${area}`}
      {...props}
      label={NAVIGATION_AREA_LABELS[area]}
      icon={<AreaIcon area={area} size={18} />}
      root
    />
  );
}

export interface NavigationGroupProps extends Omit<HTMLAttributes<HTMLDivElement>, 'id'> {
  id?: string;
  area: RecentTabArea;
  label?: string;
  expanded?: boolean;
  collapsed?: boolean;
  active?: boolean;
  disabled?: boolean;
  unavailableReason?: string;
  onToggle?: () => void;
  onOpen?: () => void;
  onPreload?: () => void;
  onAdd?: ButtonHTMLAttributes<HTMLButtonElement>['onClick'];
  addTitle?: string;
  /** Desktop can attach context menus without introducing them into other hosts. */
  decorateHeader?: (header: ReactElement) => ReactNode;
  after?: ReactNode;
}

export function NavigationGroup({
  id,
  area,
  label = NAVIGATION_AREA_LABELS[area],
  expanded = true,
  collapsed = false,
  active = false,
  disabled = false,
  unavailableReason,
  onToggle,
  onOpen,
  onPreload,
  onAdd,
  addTitle,
  decorateHeader,
  after,
  children,
  className = '',
  ...props
}: NavigationGroupProps) {
  const groupId = id ?? area;
  const reasonId = `navigation-${groupId}-unavailable`;
  const header = (
    <div className={`app-sidebar-group-header${active ? ' active' : ''}`}>
      {!collapsed && onToggle && (
        <button
          type="button"
          className="app-sidebar-caret-btn"
          onClick={onToggle}
          disabled={disabled}
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
          data-testid={`sidebar-group-toggle-${groupId}`}
        >
          <span className={`app-sidebar-caret${expanded ? ' expanded' : ''}`} aria-hidden="true">
            <svg
              width={14}
              height={14}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.2}
              strokeLinecap="round"
              strokeLinejoin="round"
              focusable="false"
              aria-hidden="true"
            >
              <polyline points="9 6 15 12 9 18" />
            </svg>
          </span>
        </button>
      )}
      <button
        type="button"
        className="app-sidebar-group-toggle"
        onClick={onOpen}
        onPointerEnter={onPreload}
        onFocus={onPreload}
        onPointerDown={onPreload}
        disabled={disabled}
        aria-current={active ? 'page' : undefined}
        aria-describedby={unavailableReason ? reasonId : undefined}
        title={label}
        data-testid={`sidebar-group-${groupId}`}
      >
        <span className="app-sidebar-item-icon">
          <AreaIcon area={area} size={18} />
        </span>
        <span className="app-sidebar-item-label app-sidebar-group-label">{label}</span>
      </button>
      {!collapsed && onAdd && (
        <button
          type="button"
          className="app-sidebar-add"
          onClick={onAdd}
          title={addTitle}
          aria-label={addTitle}
          disabled={disabled}
        >
          <svg
            width={12}
            height={12}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.4}
            strokeLinecap="round"
            focusable="false"
            aria-hidden="true"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      )}
    </div>
  );
  return (
    <div
      {...props}
      className={`app-sidebar-group${className ? ` ${className}` : ''}`}
      data-group={groupId}
    >
      {decorateHeader ? decorateHeader(header) : header}
      {unavailableReason && !collapsed && (
        <p id={reasonId} className="app-sidebar-unavailable">
          {unavailableReason}
        </p>
      )}
      {expanded && !collapsed && children && <ul className="app-sidebar-list">{children}</ul>}
      {after}
    </div>
  );
}

function HomeIcon() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5 10v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9" />
      <path d="M9.5 20v-5h5v5" />
    </svg>
  );
}
