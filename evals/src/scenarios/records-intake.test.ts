import { describe, expect, it } from 'vitest';
import { RECORDS_SEED_FILES, checkAttendeesCsv, recordsRepairDirective } from './records-intake.ts';

/**
 * Reference solution: all 15 unique attendees across the three sources
 * (16 raw registrations minus Mara's legacy duplicate minus Otis's
 * legacy standard row), dates normalized, newest-wins dedupe, quoted
 * comma name.
 */
const REFERENCE_CSV = [
  'id,full_name,email,company,ticket_type,registered_date',
  'A1,Mara Lindqvist,mara@nordfjell.example,Nordfjell Analytics,standard,2026-06-12',
  'A2,Otis Bramble,otis@bramble.example,Bramble & Cole,vip,2026-06-13',
  'A3,June Cole,june@bramble.example,Bramble & Cole,standard,2026-06-13',
  'A4,Priya Raman,priya@uni-atrium.example,Atrium University,student,2026-06-13',
  'A5,Hendrik Vos,hendrik@vos-logistics.example,Vos Logistics,vip,2026-06-14',
  'A6,Ana Sousa,ana@maretide.example,Maretide Labs,standard,2026-06-14',
  'A7,Tomas Eriksen,tomas@nordfjell.example,Nordfjell Analytics,standard,2026-06-15',
  'A8,Freya Dunlop,freya@copperline.example,Copperline Studio,vip,2026-06-15',
  'A9,"Kettle, Rosa",rosa@kettleworks.example,Kettleworks,student,2026-06-16',
  'A10,Ibrahim Sall,ibrahim@sahelsoft.example,SahelSoft,standard,2026-06-16',
  'A11,Wen Zhao,wen@lumenring.example,Lumenring,vip,2026-06-17',
  'A12,Dara Quinn,dara@quinnmaps.example,Quinn Maps,standard,2026-06-17',
  'A13,Sam Okafor,sam@brightquay.example,Brightquay,standard,2026-06-02',
  'A14,Leena Hart,leena@hartwood.example,Hartwood & Frame,vip,2026-06-04',
  'A15,Noor Haddad,noor@atlaspress.example,Atlas Press,student,2026-06-05',
].join('\n');

describe('records-intake grader', () => {
  it('the reference CSV passes shape, schema, and golden rows', () => {
    const check = checkAttendeesCsv(REFERENCE_CSV);
    expect(check.failReason).toBeUndefined();
    expect(check.goldenDiffs).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it('a wrong header set fails the shape signal with the gap named', () => {
    const check = checkAttendeesCsv('name,email\nRosa,rosa@kettleworks.example');
    expect(check.ok).toBe(false);
    expect(check.failReason).toMatch(/csv shape/);
  });

  it('each planted trap flips its golden row', () => {
    const badDate = REFERENCE_CSV.replace('2026-06-16', '16/06/2026');
    const dateCheck = checkAttendeesCsv(badDate);
    expect(dateCheck.ok).toBe(false);

    const staleOtis = REFERENCE_CSV.replace(
      'A2,Otis Bramble,otis@bramble.example,Bramble & Cole,vip,2026-06-13',
      'A2,Otis Bramble,otis@bramble.example,Bramble & Cole,standard,2026-06-03',
    );
    const otisCheck = checkAttendeesCsv(staleOtis);
    expect(otisCheck.ok).toBe(false);
    expect(otisCheck.goldenDiffs.some((d) => d.label.includes('otis'))).toBe(true);

    const duped = `${REFERENCE_CSV}\nA16,Otis Bramble,otis@bramble.example,Bramble & Cole,standard,2026-06-03`;
    const dupeCheck = checkAttendeesCsv(duped);
    expect(dupeCheck.ok).toBe(false);
  });

  it('the repair directive carries the golden-diff table and the script steer', () => {
    const check = checkAttendeesCsv(REFERENCE_CSV.replace('vip,2026-06-13', 'standard,2026-06-03'));
    const directive = recordsRepairDirective(check.goldenDiffs);
    expect(directive).toContain('records/attendees.csv');
    expect(directive).toContain('| golden row | expected | got |');
    expect(directive).toMatch(/derive|script/i);
  });

  it('the seeds actually plant the traps', () => {
    const legacy = RECORDS_SEED_FILES.find((f) => f.path === 'legacy/badge-list.csv')!.content;
    expect(legacy).toContain('otis@bramble.example');
    expect(legacy).toContain('standard;2026-06-03');
    const phone = RECORDS_SEED_FILES.find((f) => f.path === 'notes/phone-intake.md')!.content;
    expect(phone).toContain('16/06/2026');
    expect(phone).toContain('"Kettle, Rosa"');
  });
});
