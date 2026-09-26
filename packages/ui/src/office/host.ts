/**
 * What the pane knows about the Office app hosting it and the open document.
 * Office.js is loaded from Microsoft's CDN by the page before any module runs.
 */

export type OfficeHostApp = 'word' | 'excel' | 'powerpoint';

export const OFFICE_HOST_LABELS: Record<OfficeHostApp, string> = {
  word: 'Word',
  excel: 'Excel',
  powerpoint: 'PowerPoint',
};

export function detectHost(): OfficeHostApp | null {
  const host = typeof Office !== 'undefined' ? Office.context?.host : undefined;
  if (host === Office.HostType.Word) return 'word';
  if (host === Office.HostType.Excel) return 'excel';
  if (host === Office.HostType.PowerPoint) return 'powerpoint';
  const declared = document.documentElement.dataset.officeHost;
  return declared === 'word' || declared === 'excel' || declared === 'powerpoint' ? declared : null;
}

/**
 * A local file path from `Office.context.document.url`, or null for an
 * unsaved document or one that lives in OneDrive / SharePoint (an https URL
 * gezel cannot map to a folder on this computer).
 */
export function documentPathFromUrl(url: string | null | undefined): string | null {
  const value = (url ?? '').trim();
  if (!value) return null;
  if (/^file:/i.test(value)) {
    try {
      const parsed = new URL(value);
      const path = decodeURIComponent(parsed.pathname);
      if (parsed.host) return `\\\\${parsed.host}${path.replace(/\//g, '\\')}`;
      // file:///C:/Users/... → C:\Users\...
      if (/^\/[a-zA-Z]:\//.test(path)) return path.slice(1).replace(/\//g, '\\');
      return path;
    } catch {
      return null;
    }
  }
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/'))
    return value;
  return null;
}

export function documentPath(): string | null {
  try {
    return documentPathFromUrl(Office.context.document.url);
  } catch {
    return null;
  }
}

export function documentTitle(path: string | null): string {
  if (!path) return 'Untitled document';
  const name = path.split(/[\\/]/).pop();
  return name || path;
}

export function isRequirementSetSupported(set: string, version: string): boolean {
  try {
    return Office.context.requirements.isSetSupported(set, version);
  } catch {
    return false;
  }
}
