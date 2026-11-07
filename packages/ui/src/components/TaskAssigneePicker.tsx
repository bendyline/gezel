import {
  type GezelSummary,
  type TaskAssignee,
  displayName,
  plainRoleTitle,
} from '@bendyline/gezel';
import { Select } from '../primitives/index.js';
import { GezelIcon } from './GezelIcon.js';
import { PersonLabel } from './PersonLabel.js';
import { useRoleBasedNameOnlyMode } from './useRoleBasedNameOnlyMode.js';
import { useShowPoppetjes } from './useShowPoppetjes.js';

interface TaskAssigneePickerProps {
  gezels: GezelSummary[];
  value: TaskAssignee | null;
  onValueChange: (assignee: TaskAssignee | null) => void;
  inheritedAssignee?: TaskAssignee | null;
  inheritLabel?: string;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}

export function TaskAssigneePicker({
  gezels,
  value,
  onValueChange,
  inheritedAssignee,
  inheritLabel = 'Same as the task',
  ariaLabel,
  disabled,
  className,
}: TaskAssigneePickerProps) {
  const showPoppetjes = useShowPoppetjes();
  const roleBasedNameOnly = useRoleBasedNameOnlyMode();
  const gezelFor = (assignee: TaskAssignee | null | undefined) =>
    assignee?.kind === 'gezel' ? gezels.find((gezel) => gezel.id === assignee.gezelId) : undefined;
  // With names hidden the name already says the role.
  const roleFor = (gezel: GezelSummary) =>
    roleBasedNameOnly || !gezel.role ? undefined : plainRoleTitle(gezel.role);
  const textFor = (gezel: GezelSummary) => {
    const role = roleFor(gezel);
    const name = displayName(gezel, roleBasedNameOnly);
    return role ? `${name} · ${role}` : name;
  };
  const row = (name: string, gezel?: GezelSummary, role?: string) => (
    <PersonLabel
      name={name}
      roleTitle={role}
      className="task-assignee-option"
      face={
        showPoppetjes && gezel ? (
          <GezelIcon
            name={displayName(gezel, roleBasedNameOnly)}
            poppetje={gezel.poppetje}
            svg={gezel.icon ?? null}
            iconOverride={gezel.iconOverride}
            size={20}
          />
        ) : undefined
      }
    />
  );
  const gezelRow = (gezel: GezelSummary) =>
    row(displayName(gezel, roleBasedNameOnly), gezel, roleFor(gezel));
  const selectedGezel = gezelFor(value ?? inheritedAssignee);
  const selected = !value
    ? row(inheritLabel, selectedGezel)
    : value.kind === 'user'
      ? row('You')
      : selectedGezel
        ? gezelRow(selectedGezel)
        : row(value.gezelId);

  return (
    <Select.Root
      value={!value ? '__inherit' : value.kind === 'user' ? '__user' : value.gezelId}
      disabled={disabled}
      onValueChange={(next) =>
        onValueChange(
          next === '__inherit'
            ? null
            : next === '__user'
              ? { kind: 'user' }
              : { kind: 'gezel', gezelId: next },
        )
      }
    >
      <Select.Trigger
        className={['task-assignee-picker', className].filter(Boolean).join(' ')}
        aria-label={ariaLabel}
        title={ariaLabel}
      >
        <Select.Value>{selected}</Select.Value>
      </Select.Trigger>
      <Select.Content className="task-assignee-menu">
        <Select.Item value="__inherit" textValue={inheritLabel}>
          {row(inheritLabel, gezelFor(inheritedAssignee))}
        </Select.Item>
        <Select.Item value="__user">You</Select.Item>
        {gezels.map((gezel) => (
          <Select.Item key={gezel.id} value={gezel.id} textValue={textFor(gezel)}>
            {gezelRow(gezel)}
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}
