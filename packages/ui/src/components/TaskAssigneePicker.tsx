import { type GezelSummary, type TaskAssignee, displayName } from '@bendyline/gezel';
import { Select } from '../primitives/index.js';
import { GezelIcon } from './GezelIcon.js';
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
  const labelFor = (gezel: GezelSummary) =>
    !roleBasedNameOnly && gezel.role
      ? `${gezel.name} · ${gezel.role}`
      : displayName(gezel, roleBasedNameOnly);
  const row = (label: string, gezel?: GezelSummary) => (
    <span className="task-assignee-option">
      {showPoppetjes && gezel && (
        <span className="task-assignee-avatar" aria-hidden="true">
          <GezelIcon
            name={displayName(gezel, roleBasedNameOnly)}
            poppetje={gezel.poppetje}
            svg={gezel.icon ?? null}
            iconOverride={gezel.iconOverride}
            size={20}
          />
        </span>
      )}
      <span className="task-assignee-option-label">{label}</span>
    </span>
  );
  const selectedGezel = gezelFor(value ?? inheritedAssignee);
  const selectedLabel = !value
    ? inheritLabel
    : value.kind === 'user'
      ? 'You'
      : selectedGezel
        ? labelFor(selectedGezel)
        : value.gezelId;

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
        <Select.Value>{row(selectedLabel, selectedGezel)}</Select.Value>
      </Select.Trigger>
      <Select.Content className="task-assignee-menu">
        <Select.Item value="__inherit" textValue={inheritLabel}>
          {row(inheritLabel, gezelFor(inheritedAssignee))}
        </Select.Item>
        <Select.Item value="__user">You</Select.Item>
        {gezels.map((gezel) => (
          <Select.Item key={gezel.id} value={gezel.id} textValue={labelFor(gezel)}>
            {row(labelFor(gezel), gezel)}
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}
