/**
 * Handoff from the New-script dialog to the editor: "this freshly
 * created script should be AI-drafted from this description". Kept in
 * module scope (not the tab payload) because RecentTab persists to
 * localStorage and a draft request must fire at most once.
 */
const pending = new Map<string, string>();

export function setPendingDraft(key: string, description: string): void {
  pending.set(key, description);
}

export function takePendingDraft(key: string): string | null {
  const description = pending.get(key) ?? null;
  pending.delete(key);
  return description;
}
