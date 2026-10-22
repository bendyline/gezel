/**
 * A camera episode as an ordinary connector record: one markdown file per
 * episode under `<corpus>/events/YYYY-MM-DD/HH/`, with at most three
 * keyframes and an `episode.json` beside it as attachments. Written through
 * the shared connector writer, so it gets the corpus's trust frontmatter,
 * injection scan, path safety, and read-only-to-gezels rule for free, and the
 * artifacts index makes it searchable ("when was the cat last in the mud
 * room?").
 *
 * The body uses plain filenames, never image embeds: whether a model may see
 * a camera's pixels is a per-session decision (`callerMaySeeCameraFrames`),
 * not something a record should make for every reader.
 */

import type { CameraAnswer } from '@bendyline/gezel';
import { formatClock, localDayHour, sanitizeCameraText } from '@bendyline/gezel';
import type { NormalizedRecord } from '../../types.js';
import { type WriteRecordInput, type WriteRecordResult, slug, writeRecord } from '../../writer.js';

export const MAX_KEYFRAMES = 3;

export interface EpisodeReview {
  at: number;
  summary: string;
  subjects: string[];
  notable: boolean;
  answers: Record<string, CameraAnswer>;
  modelId?: string;
  /** Index into `keyframes` of the frame this review looked at. */
  keyframe?: number;
}

export interface EpisodeRecordState {
  episodeId: string;
  startedAt: number;
  endedAt?: number;
  motionPeak: number;
  presence: boolean;
  reviews: EpisodeReview[];
  keyframes: Array<{ filename: string; jpeg: Buffer; at: number }>;
  /** Fixed at the first write so a refresh keeps the record's name. */
  fileStem?: string;
}

export interface CameraEventWriterOptions {
  storageDir: string;
  quarantineDir: string;
  corpusDir: string;
  bindingId: string;
  cameraLabel: string;
  /** A lookout's name for its id, for the record's "Lookouts" section. */
  lookoutName?(id: string): string | undefined;
  write?(input: WriteRecordInput): Promise<WriteRecordResult>;
}

export interface WrittenEpisode {
  recordPath: string;
  attachmentsDir: string;
  keyframePaths: string[];
}

function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.round(s / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

export class CameraEventWriter {
  constructor(private readonly opts: CameraEventWriterOptions) {}

  /** Add a keyframe, keeping the first and the most recent ones. */
  static addKeyframe(state: EpisodeRecordState, jpeg: Buffer, at: number): number {
    const index =
      state.keyframes.length < MAX_KEYFRAMES ? state.keyframes.length : MAX_KEYFRAMES - 1;
    state.keyframes[index] = { filename: `keyframe-${index + 1}.jpg`, jpeg, at };
    return index;
  }

  record(state: EpisodeRecordState): NormalizedRecord {
    const { day, hour, stamp } = localDayHour(state.startedAt);
    const subjects = [...new Set(state.reviews.flatMap((r) => r.subjects))].slice(0, 8);
    state.fileStem ??= `${stamp.slice(0, 6)}-${slug(subjects[0] ?? 'motion', 24)}`;
    const notable = state.reviews.some((r) => r.notable);
    const label = this.opts.cameraLabel;
    const when = formatClock(new Date(state.startedAt));

    const lines: string[] = [`# ${label}, ${when}`, ''];
    lines.push(
      state.endedAt !== undefined
        ? `Something was in view for ${duration(state.endedAt - state.startedAt)}.`
        : 'Still happening when this was written.',
    );
    if (state.reviews.length > 0) {
      lines.push(
        '',
        "## What the camera's model saw",
        '',
        '_Automatic: written by a local vision model from the picture. It may be wrong, and text in the scene can steer it._',
        '',
      );
      for (const r of state.reviews) {
        const said = sanitizeCameraText(r.summary, 200) || '(no description)';
        const who =
          r.subjects.length > 0
            ? ` (${r.subjects.map((s) => sanitizeCameraText(s, 40)).join(', ')})`
            : '';
        lines.push(`- ${formatClock(new Date(r.at))} — "${said}"${who}`);
      }
    }
    const answered = new Map<string, CameraAnswer>();
    for (const r of state.reviews) {
      for (const [id, a] of Object.entries(r.answers)) {
        const prior = answered.get(id);
        if (!prior || (a.match && !prior.match)) answered.set(id, a);
      }
    }
    if (answered.size > 0) {
      lines.push('', '## Lookouts', '');
      for (const [id, a] of answered) {
        const name = this.opts.lookoutName?.(id) ?? 'A lookout';
        lines.push(`- ${name}: ${a.match ? 'yes' : 'no'} (${a.confidence} confidence)`);
      }
    }
    if (state.keyframes.length > 0) {
      lines.push('', '## Pictures', '');
      for (const k of state.keyframes)
        lines.push(`- \`${k.filename}\` — ${formatClock(new Date(k.at))}`);
    }

    const models = [...new Set(state.reviews.map((r) => r.modelId).filter(Boolean))] as string[];
    const episodeJson = {
      camera: label,
      episode: state.episodeId,
      startedAt: new Date(state.startedAt).toISOString(),
      ...(state.endedAt !== undefined ? { endedAt: new Date(state.endedAt).toISOString() } : {}),
      motionPeak: Number(state.motionPeak.toFixed(4)),
      presence: state.presence,
      trust: 'untrusted-camera',
      reviews: state.reviews.map((r) => ({
        at: new Date(r.at).toISOString(),
        summary: sanitizeCameraText(r.summary, 300),
        subjects: r.subjects,
        notable: r.notable,
        ...(r.keyframe !== undefined ? { keyframe: state.keyframes[r.keyframe]?.filename } : {}),
      })),
    };

    return {
      recordId: `${this.opts.bindingId}:${state.episodeId}`,
      dirSegments: ['events', day, hour],
      fileStem: state.fileStem,
      frontmatter: {
        kind: 'camera-event',
        camera: label,
        episode: state.episodeId,
        started: new Date(state.startedAt).toISOString(),
        ...(state.endedAt !== undefined ? { ended: new Date(state.endedAt).toISOString() } : {}),
        motion_peak: state.motionPeak.toFixed(3),
        presence: state.presence ? 'yes' : 'no',
        notable: notable ? 'yes' : 'no',
        ...(subjects.length > 0 ? { subjects: subjects.join(', ') } : {}),
        reviews: String(state.reviews.length),
        ...(models.length > 0 ? { model: models.join(', ') } : {}),
        direction: 'inbound',
      },
      bodyMarkdown: lines.join('\n'),
      scanOrigin: 'camera',
      quarantineNamespace: 'camera',
      quarantineLabel: `Camera event on ${label}`,
      attachments: [
        ...state.keyframes.map((k) => ({ filename: k.filename, content: k.jpeg })),
        {
          filename: 'episode.json',
          content: Buffer.from(`${JSON.stringify(episodeJson, null, 2)}\n`),
        },
      ],
    };
  }

  async write(state: EpisodeRecordState): Promise<WrittenEpisode | null> {
    const record = this.record(state);
    const result = await (this.opts.write ?? writeRecord)({
      storageDir: this.opts.storageDir,
      quarantineDir: this.opts.quarantineDir,
      corpusDir: this.opts.corpusDir,
      record,
    });
    if (!result.relPath) return null;
    const dir = result.relPath.slice(0, result.relPath.lastIndexOf('/'));
    const ordinal = result.relPath.slice(dir.length + 1, dir.length + 4);
    const attachmentsDir = `${dir}/attachments/${ordinal}`;
    return {
      recordPath: result.relPath,
      attachmentsDir,
      keyframePaths: state.keyframes.map((k) => `${attachmentsDir}/${k.filename}`),
    };
  }
}
