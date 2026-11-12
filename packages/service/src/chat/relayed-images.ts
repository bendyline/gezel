/**
 * Pictures a delegate made, carried along with its reply.
 *
 * A delegation's reply reaches the sender's chat as text, while the picture
 * the delegate made belongs to one of its tool calls. Relayed as text alone,
 * the person saw the picture only in the delegate's thread, and the sender's
 * model, holding no path, wrote one: an `example.com` URL around an unrelated
 * image retrieval had surfaced (qwen2.5-7b Meester, 2026-11-11).
 */
import type { ChatMessage, ToolCallImage } from '@bendyline/gezel';
import { extractGeneratedImageArtifactPath } from './image-refinement.js';

/** Tools whose images are pictures a gezel made, not screenshots or reads of existing files. */
const PICTURE_MAKING_TOOLS = new Set(['generate_image', 'render_image']);

/** A runaway render loop should not paper the sender's chat. */
const MAX_RELAYED_IMAGES = 8;

/**
 * The pictures a finished turn made, by the artifact path the tool reported
 * (`generated/…` for `generate_image`), falling back to the thumbnail copy the
 * bridge stored under `sessions/…`. The reported path is the one the artifacts
 * drawer lists and the one a follow-up edit or animation takes.
 */
export function collectMadePictures(message: Pick<ChatMessage, 'toolCalls'>): ToolCallImage[] {
  const out: ToolCallImage[] = [];
  const seen = new Set<string>();
  for (const call of message.toolCalls ?? []) {
    if (!call.success || !PICTURE_MAKING_TOOLS.has(call.name)) continue;
    const thumbnails = call.images ?? [];
    const reported = reportedPicturePath(call.name, call.resultText);
    const picks = reported
      ? [{ path: reported, mimeType: thumbnails[0]?.mimeType ?? mimeTypeForPath(reported) }]
      : thumbnails;
    for (const pick of picks) {
      if (seen.has(pick.path)) continue;
      seen.add(pick.path);
      out.push(pick);
      if (out.length >= MAX_RELAYED_IMAGES) return out;
    }
  }
  return out;
}

function reportedPicturePath(tool: string, resultText: string | undefined): string | undefined {
  if (!resultText) return undefined;
  const path =
    tool === 'generate_image'
      ? extractGeneratedImageArtifactPath(resultText)
      : /^Rendered \d+×\d+ \S+ to artifacts\/(\S+) \(/.exec(resultText)?.[1];
  return path?.replace(/^artifacts\//, '') || undefined;
}

function mimeTypeForPath(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

/** The relayed message's words when the delegate made pictures but wrote nothing. */
export function picturesOnlyReplyText(count: number): string {
  return count === 1 ? 'Sent a picture.' : `Sent ${count} pictures.`;
}

/**
 * The per-turn note for the gezel receiving a relayed reply with pictures.
 * Names each picture's exact path so the reply can point to it, and forbids
 * a link of its own: the person already sees the pictures with the message.
 */
export function relayedPicturesNote(senderName: string, images: readonly ToolCallImage[]): string {
  const one = images.length === 1;
  const what = one ? 'a picture' : `${images.length} pictures`;
  const it = one ? 'it' : 'them';
  const paths = images.map((img) => `\`artifacts/${img.path}\``).join(', ');
  const name = one ? 'name that exact path' : 'name their exact paths';
  return `(System note for this turn: ${senderName} made ${what}, and the person sees ${it} with ${senderName}'s message below: ${paths}. To point to ${it}, ${name}. Never write an image link or a web address for ${it}.)`;
}
