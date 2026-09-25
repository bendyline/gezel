import { PORTABLE_MAX_RECORD_BYTES } from './files.js';

export function speechBase64(bytes: Uint8Array): string {
  if (!bytes.length || bytes.length > PORTABLE_MAX_RECORD_BYTES)
    throw new Error('Audio must be between 1 byte and 16 MiB.');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

export function speechBytes(data: string): Uint8Array {
  if (
    !data ||
    data.length > Math.ceil(PORTABLE_MAX_RECORD_BYTES / 3) * 4 ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  )
    throw new Error('Audio must be valid base64, up to 16 MiB.');
  const binary = atob(data);
  if (btoa(binary) !== data || binary.length > PORTABLE_MAX_RECORD_BYTES)
    throw new Error('Audio must be valid base64, up to 16 MiB.');
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
