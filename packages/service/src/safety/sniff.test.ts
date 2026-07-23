import { describe, expect, it } from 'vitest';
import { detectContainer, sniffContainer } from './sniff.js';

const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]); // %PDF-1
const JUNK = new Uint8Array([0x00, 0x01, 0x02, 0x03]);

describe('detectContainer', () => {
  it('detects ZIP and PDF leading bytes', () => {
    expect(detectContainer(ZIP)).toBe('zip');
    expect(detectContainer(PDF)).toBe('pdf');
    expect(detectContainer(JUNK)).toBe('unknown');
  });
});

describe('sniffContainer', () => {
  it('accepts a real OOXML zip for an ooxml extension', () => {
    expect(sniffContainer(ZIP, 'docx')).toEqual({ detected: 'zip', matchesExtension: true });
    expect(sniffContainer(ZIP, '.pptx')).toEqual({ detected: 'zip', matchesExtension: true });
  });

  it('accepts a real pdf for the pdf extension', () => {
    expect(sniffContainer(PDF, 'pdf').matchesExtension).toBe(true);
  });

  it('flags type confusion: a pdf masquerading as docx', () => {
    expect(sniffContainer(PDF, 'docx')).toEqual({ detected: 'pdf', matchesExtension: false });
  });

  it('flags a non-container masquerading as an ooxml file', () => {
    expect(sniffContainer(JUNK, 'xlsx').matchesExtension).toBe(false);
  });

  it('has no magic expectation for extensions without a signature', () => {
    expect(sniffContainer(JUNK, 'html').matchesExtension).toBe(true);
  });
});
