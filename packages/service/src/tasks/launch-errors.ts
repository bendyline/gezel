import type { CraftbookConnectorNeed, CraftbookToolsetNeed } from '@bendyline/gezel';

/*
 * The errors a launch raises when the craftbook is sound but the project is
 * not ready for it. The create route answers each with a 409 whose message is
 * the fix; a craftbook-input problem is the sibling `TaskInputError`
 * (tasks/inputs), answered with a 422.
 */

/** A craftbook was selected correctly, but its declared runtime is not ready. */
export class CraftbookSetupRequiredError extends Error {
  readonly code = 'CRAFTBOOK_SETUP_REQUIRED';

  constructor(
    readonly craftbookId: string,
    readonly missingToolsets: CraftbookToolsetNeed[],
  ) {
    const details = missingToolsets
      .map((need) => `${need.toolsetId}${need.reason ? ` (${need.reason})` : ''}`)
      .join(', ');
    super(
      `SETUP REQUIRED for craftbook "${craftbookId}": install/configure ${details} before creating this task. No task was created.`,
    );
    this.name = 'CraftbookSetupRequiredError';
  }
}

/**
 * A craftbook reads a connector corpus the project has not bound. The
 * launcher offers to bind it (defaults come from the project) and retries.
 */
export class ConnectorSetupRequiredError extends Error {
  readonly code = 'CONNECTOR_SETUP_REQUIRED';

  constructor(
    readonly craftbookId: string,
    readonly missingConnectors: CraftbookConnectorNeed[],
  ) {
    const details = missingConnectors
      .map((need) => `${need.typeId}${need.reason ? ` (${need.reason})` : ''}`)
      .join(', ');
    super(
      `SETUP REQUIRED for craftbook "${craftbookId}": connect ${details} before creating this task. No task was created.`,
    );
    this.name = 'ConnectorSetupRequiredError';
  }
}
