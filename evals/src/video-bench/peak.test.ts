import { describe, expect, it } from 'vitest';
import { parseFootprintPeaks, parseGpuInUse } from './peak.ts';

describe('parseFootprintPeaks', () => {
  it('reads each process block, current and lifetime peak', () => {
    const stdout = `======================================================================
gezel-sd-server [101]: 64-bit    Footprint: 9000 B (16384 bytes per page)
======================================================================

Auxiliary data:
    phys_footprint: 9000 B
    phys_footprint_peak: 12000 B

======================================================================
node [102]: 64-bit    Footprint: 500 B (16384 bytes per page)
======================================================================

Auxiliary data:
    phys_footprint: 500 B
    phys_footprint_peak: 800 B
`;
    expect(parseFootprintPeaks(stdout)).toEqual([
      { current: 9000, peak: 12000, untagged: 0, graphics: 0 },
      { current: 500, peak: 800, untagged: 0, graphics: 0 },
    ]);
  });

  it("reads the Untagged category, where Metal buffers sit, and the GPU's own", () => {
    const stdout = `======================================================================
gezel-sd-server [3915]: 64-bit    Footprint: 8126454648 B (16384 bytes per page)
======================================================================

      Dirty       Clean  Reclaimable    Regions    Category
        ---         ---          ---        ---    ---
7490945024 B           0 B           0 B         93    Untagged
 356515840 B           0 B           0 B         48    Malloc Large
 125829120 B           0 B           0 B         15    Owned physical footprint (unmapped) (graphics)
   9732096 B           0 B     1245184 B        322    IOAccelerator (graphics)
8126454648 B    42827776 B    31244288 B       3901    TOTAL

Auxiliary data:
    phys_footprint: 8126454648 B
    phys_footprint_peak: 8197200736 B
`;
    expect(parseFootprintPeaks(stdout)).toEqual([
      { current: 8126454648, peak: 8197200736, untagged: 7490945024, graphics: 135561216 },
    ]);
  });

  it('reads nothing from an error', () => {
    expect(parseFootprintPeaks('footprint: Unable to find any processes')).toEqual([]);
  });
});

describe('parseGpuInUse', () => {
  it("reads the GPU driver's in-use memory", () => {
    const stdout =
      '"PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=12667027456,"In use system memory"=10297933824}';
    expect(parseGpuInUse(stdout)).toBe(10297933824);
  });

  it('answers null without the statistic', () => {
    expect(parseGpuInUse('')).toBeNull();
  });
});
