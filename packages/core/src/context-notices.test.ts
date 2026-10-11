import { describe, expect, it } from 'vitest';
import {
  CONDENSED_TOOL_OUTPUT_NOTICE,
  autoCompactedNotice,
  isContextMaintenanceNotice,
} from './context-notices.js';

describe('context-maintenance notices', () => {
  it('recognizes what the emitters produce', () => {
    expect(autoCompactedNotice(1, 40_960)).toBe(
      'Auto-compacted 1 earlier message in this 40,960-token context window so the current turn could continue.',
    );
    expect(isContextMaintenanceNotice(autoCompactedNotice(34, 40_960))).toBe(true);
    expect(isContextMaintenanceNotice(CONDENSED_TOOL_OUTPUT_NOTICE)).toBe(true);
  });

  it('leaves real warnings alone', () => {
    expect(isContextMaintenanceNotice('Provider is busy.')).toBe(false);
    expect(
      isContextMaintenanceNotice('Context compaction failed; older messages may be lost.'),
    ).toBe(false);
  });
});
