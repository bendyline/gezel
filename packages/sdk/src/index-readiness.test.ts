import type {
  IndexReadinessReport as CoreIndexReadinessReport,
  WorkspaceIndexStatus as CoreWorkspaceIndexStatus,
} from '@bendyline/gezel';
import { describe, expectTypeOf, it } from 'vitest';
import type { IndexReadinessReport, WorkspaceIndexStatus } from './index-readiness.js';

describe('self-contained index wire types', () => {
  it('stay structurally aligned with the canonical core schemas', () => {
    expectTypeOf<IndexReadinessReport>().toMatchTypeOf<CoreIndexReadinessReport>();
    expectTypeOf<CoreIndexReadinessReport>().toMatchTypeOf<IndexReadinessReport>();
    expectTypeOf<WorkspaceIndexStatus>().toMatchTypeOf<CoreWorkspaceIndexStatus>();
    expectTypeOf<CoreWorkspaceIndexStatus>().toMatchTypeOf<WorkspaceIndexStatus>();
  });
});
