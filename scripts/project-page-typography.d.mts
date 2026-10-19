export function buildProjectPageTypography(uiRoot: string): string;
export function projectPageTypographyPlugin(uiRoot: string): {
  name: string;
  resolveId(source: string): string | null;
  load(source: string): string | null;
};
