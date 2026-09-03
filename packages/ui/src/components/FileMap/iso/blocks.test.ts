import { describe, expect, it } from 'vitest';
import { shouldDrawSymbolCampus } from './blocks.js';

const code = { id: 'src/manager.ts', lang: 'typescript', buildingCount: 4 };
const config = { id: 'packages/ui/vite.config.ts', lang: 'typescript', buildingCount: 2 };

describe('isometric symbol campus visibility', () => {
  it('keeps miniature symbol buildings visible at neighborhood and street zoom', () => {
    expect(shouldDrawSymbolCampus('district', false, 4, code)).toBe(true);
    expect(shouldDrawSymbolCampus('street', false, 4, code)).toBe(true);
  });

  it('uses flat lots at city zoom and a simple file surface for the age lens', () => {
    expect(shouldDrawSymbolCampus('city', false, 4, code)).toBe(false);
    expect(shouldDrawSymbolCampus('district', true, 4, code)).toBe(false);
    expect(shouldDrawSymbolCampus('street', false, 0, { ...code, buildingCount: 0 })).toBe(false);
  });

  it('never turns a config file into a campus — it is the signal tower', () => {
    expect(shouldDrawSymbolCampus('street', false, 2, config)).toBe(false);
  });
});
