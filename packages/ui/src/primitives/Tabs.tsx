import * as RadixTabs from '@radix-ui/react-tabs';

export function Root(props: RadixTabs.TabsProps) {
  const { className, ...rest } = props;
  return (
    <RadixTabs.Root
      {...rest}
      className={className ? `gz-tabs-root ${className}` : 'gz-tabs-root'}
    />
  );
}

export function List(props: RadixTabs.TabsListProps) {
  const { className, ...rest } = props;
  return (
    <RadixTabs.List
      {...rest}
      className={className ? `gz-tabs-list ${className}` : 'gz-tabs-list'}
    />
  );
}

export function Trigger(props: RadixTabs.TabsTriggerProps) {
  const { className, ...rest } = props;
  return (
    <RadixTabs.Trigger
      {...rest}
      className={className ? `gz-tabs-trigger ${className}` : 'gz-tabs-trigger'}
    />
  );
}

export function Content(props: RadixTabs.TabsContentProps) {
  const { className, ...rest } = props;
  return (
    <RadixTabs.Content
      {...rest}
      className={className ? `gz-tabs-content ${className}` : 'gz-tabs-content'}
    />
  );
}
