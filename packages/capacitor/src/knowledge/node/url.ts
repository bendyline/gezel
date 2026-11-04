export const pathToFileURL = (path: string) =>
  new URL(`file://${path.split('/').map(encodeURIComponent).join('/')}`);
export const fileURLToPath = (url: string | URL) => decodeURIComponent(new URL(url).pathname);
