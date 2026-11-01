import { describe, expectTypeOf, it } from 'vitest';
// Compare current schemas without depending on core's generated declaration files.
import type { WorkspaceIndexStatus as CoreWorkspaceIndexStatus } from '../../core/src/schemas/api.js';
import type { IndexReadinessReport as CoreIndexReadinessReport } from '../../core/src/schemas/index-readiness.js';
import type { IndexReadinessReport, WorkspaceIndexStatus } from './index-readiness.js';

describe('self-contained index wire types', () => {
  it('stay structurally aligned with the canonical core schemas', () => {
    expectTypeOf<IndexReadinessReport>().toMatchTypeOf<CoreIndexReadinessReport>();
    expectTypeOf<CoreIndexReadinessReport>().toMatchTypeOf<IndexReadinessReport>();
    expectTypeOf<WorkspaceIndexStatus>().toMatchTypeOf<CoreWorkspaceIndexStatus>();
    expectTypeOf<CoreWorkspaceIndexStatus>().toMatchTypeOf<WorkspaceIndexStatus>();
  });
});
