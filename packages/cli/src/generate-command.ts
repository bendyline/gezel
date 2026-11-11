import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_QUALITIES,
  ImageAspectRatioSchema,
  ImageQualitySchema,
} from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client/node';
import type { Command } from 'commander';
import { CliError } from './connection.js';
import {
  enumOpt,
  floatOpt,
  intOpt,
  readPictureOpt,
  resolvePromptText,
  saveArtifact,
} from './generate.js';

interface GenCommonOpts {
  file?: string;
  model?: string;
  project?: string;
  output?: string;
}

/**
 * `gezel create-image` / `create-video` / `create-audio`: one-shot calls into
 * the configured generators. The prompt or text comes from the variadic
 * argument or `--file <path>`; `--model` overrides the engine default. Output
 * bytes are pulled back from the daemon and written to a local file (cwd by
 * default, or `--output`).
 */
export function registerGenerateCommands(
  program: Command,
  connect: () => Promise<GezelClient>,
): void {
  program
    .command('create-image [prompt...]')
    .description('Generate an image from a prompt (or --file) via the configured image engine')
    .option('-f, --file <path>', 'read the prompt from a text file instead of the argument')
    .option('-m, --model <id>', 'image model catalog id (default: the engine default)')
    .option('-n, --negative <text>', 'negative prompt')
    .option('-W, --width <px>', 'width in pixels')
    .option('-H, --height <px>', 'height in pixels')
    .option('-a, --aspect <ratio>', `aspect ratio: ${IMAGE_ASPECT_RATIOS.join(', ')}`)
    .option('-q, --quality <tier>', `size tier: ${IMAGE_QUALITIES.join(', ')} (default: standard)`)
    .option('-s, --steps <n>', 'sampler steps (default: the model recommendation)')
    .option('--seed <n>', 'seed for reproducible output')
    .option('-p, --project <id>', 'project to write the artifact under', 'default')
    .option('-o, --output <path>', 'write the image here (default: ./<artifact name>)')
    .action(
      async (
        promptParts: string[],
        opts: GenCommonOpts & {
          negative?: string;
          width?: string;
          height?: string;
          aspect?: string;
          quality?: string;
          steps?: string;
          seed?: string;
        },
      ) => {
        const aspect = enumOpt('aspect', opts.aspect, ImageAspectRatioSchema);
        const quality = enumOpt('quality', opts.quality, ImageQualitySchema);
        const prompt = await resolvePromptText(promptParts, opts.file, 'prompt');
        const client = await connect();
        const projectId = opts.project ?? 'default';
        const width = intOpt('width', opts.width);
        const height = intOpt('height', opts.height);
        const steps = intOpt('steps', opts.steps);
        const seed = intOpt('seed', opts.seed);
        console.error(`generating image${opts.model ? ` (model ${opts.model})` : ''}...`);
        let res: Awaited<ReturnType<typeof client.generateImage>>;
        try {
          res = await client.generateImage({
            prompt,
            projectId,
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.negative ? { negativePrompt: opts.negative } : {}),
            ...(width !== undefined ? { width } : {}),
            ...(height !== undefined ? { height } : {}),
            ...(aspect ? { aspectRatio: aspect } : {}),
            ...(quality ? { quality } : {}),
            ...(steps !== undefined ? { steps } : {}),
            ...(seed !== undefined ? { seed } : {}),
          });
        } catch (err) {
          throw new CliError(
            `image generation failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const dest = await saveArtifact(client, projectId, res.artifactPath, opts.output);
        const m = res.meta;
        console.log(dest);
        console.error(
          `  model=${m.model} seed=${m.seed} steps=${m.steps} size=${m.widthPx}x${m.heightPx} time=${(m.durationMs / 1000).toFixed(1)}s`,
        );
      },
    );

  program
    .command('create-video [prompt...]')
    .description(
      'Generate a video from a prompt (or --file), or animate a picture (--image), via the configured video engine',
    )
    .option('-f, --file <path>', 'read the prompt from a text file instead of the argument')
    .option('-m, --model <id>', 'video model catalog id (default: the engine default)')
    .option('-n, --negative <text>', 'negative prompt')
    .option('-W, --width <px>', 'width in pixels')
    .option('-H, --height <px>', 'height in pixels')
    .option('-i, --image <path>', 'a picture to animate; it becomes the first frame')
    .option('-a, --aspect <ratio>', `aspect ratio: ${IMAGE_ASPECT_RATIOS.join(', ')}`)
    .option('--frames <n>', 'number of frames')
    .option('--fps <n>', 'frames per second')
    .option('-s, --steps <n>', 'sampler steps')
    .option('--seed <n>', 'seed for reproducible output')
    .option('-p, --project <id>', 'project to write the artifact under', 'default')
    .option('-o, --output <path>', 'write the video here (default: ./<artifact name>)')
    .action(
      async (
        promptParts: string[],
        opts: GenCommonOpts & {
          negative?: string;
          width?: string;
          height?: string;
          image?: string;
          aspect?: string;
          frames?: string;
          fps?: string;
          steps?: string;
          seed?: string;
        },
      ) => {
        const prompt = await resolvePromptText(promptParts, opts.file, 'prompt');
        const aspect = enumOpt('aspect', opts.aspect, ImageAspectRatioSchema);
        const picture = opts.image ? await readPictureOpt(opts.image) : undefined;
        const client = await connect();
        const projectId = opts.project ?? 'default';
        const width = intOpt('width', opts.width);
        const height = intOpt('height', opts.height);
        const numFrames = intOpt('frames', opts.frames);
        const fps = intOpt('fps', opts.fps);
        const steps = intOpt('steps', opts.steps);
        const seed = intOpt('seed', opts.seed);
        console.error(
          `generating video${opts.model ? ` (model ${opts.model})` : ''} — this can take a while...`,
        );
        let res: Awaited<ReturnType<typeof client.generateVideo>>;
        try {
          res = await client.generateVideo({
            prompt,
            projectId,
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.negative ? { negativePrompt: opts.negative } : {}),
            ...(width !== undefined ? { width } : {}),
            ...(height !== undefined ? { height } : {}),
            ...(aspect ? { aspectRatio: aspect } : {}),
            ...(picture ? { inputImage: picture, requireImageToVideo: true } : {}),
            ...(numFrames !== undefined ? { numFrames } : {}),
            ...(fps !== undefined ? { fps } : {}),
            ...(steps !== undefined ? { steps } : {}),
            ...(seed !== undefined ? { seed } : {}),
          });
        } catch (err) {
          throw new CliError(
            `video generation failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const dest = await saveArtifact(client, projectId, res.artifactPath, opts.output);
        const m = res.meta;
        console.log(dest);
        console.error(
          `  model=${m.model} seed=${m.seed} ${m.widthPx}x${m.heightPx} frames=${m.numFrames} fps=${m.fps} time=${(m.durationMs / 1000).toFixed(1)}s`,
        );
        for (const note of m.settingsNotes ?? []) console.error(`  note: ${note}`);
      },
    );

  program
    .command('create-audio [text...]')
    .description('Synthesize speech from text (or --file) via the configured TTS engine')
    .option('-f, --file <path>', 'read the text from a file instead of the argument')
    .option('-m, --model <id>', 'TTS model catalog id (default: the engine default)')
    .option('--voice <id>', 'voice id (default: the model or crew member default)')
    .option('--speed <x>', 'speed multiplier, 0.25-4 (default: 1.0)')
    .option('-p, --project <id>', 'project to write the artifact under', 'default')
    .option('-o, --output <path>', 'write the audio here (default: ./<artifact name>)')
    .action(
      async (textParts: string[], opts: GenCommonOpts & { voice?: string; speed?: string }) => {
        const text = await resolvePromptText(textParts, opts.file, 'text');
        const client = await connect();
        const projectId = opts.project ?? 'default';
        const speed = floatOpt('speed', opts.speed);
        console.error('synthesizing speech...');
        let res: Awaited<ReturnType<typeof client.synthesizeSpeech>>;
        try {
          res = await client.synthesizeSpeech({
            text,
            projectId,
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.voice ? { voice: opts.voice } : {}),
            ...(speed !== undefined ? { speed } : {}),
          });
        } catch (err) {
          throw new CliError(
            `speech synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (!res.artifactPath) throw new CliError('speech synthesis returned no saved audio');
        const dest = await saveArtifact(client, projectId, res.artifactPath, opts.output);
        const m = res.meta;
        console.log(dest);
        console.error(
          `  voice=${m.voice} model=${m.model} ${m.durationSeconds.toFixed(1)}s @ ${m.sampleRate}Hz`,
        );
      },
    );
}
