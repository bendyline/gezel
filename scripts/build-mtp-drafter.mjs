#!/usr/bin/env node
/**
 * Build a publishable MTP speculative-decoding drafter for an MLX model.
 *
 * Speculative decoding needs a drafter carrying the model's multi-token
 * prediction head, and no MLX conversion on the Hub has one: both mlx-lm and
 * mlx-vlm delete `mtp.*` tensors in `sanitize()` at conversion time. The head
 * survives only in the original bf16 checkpoint, so a drafter is *derived*
 * rather than downloaded — this script is that derivation, kept in the repo so
 * the artifact we publish is reproducible instead of a one-off someone built
 * on a laptop once.
 *
 * Three steps, cheap because only one shard matters:
 *   1. Read the source repo's weight index and fetch ONLY the shard(s) holding
 *      `mtp.*` (for Qwen3.8-27B that is 1 of 18 — 3.4 GB, not 55 GB).
 *   2. Split the head out with mlx_vlm's drafter splitter.
 *   3. Quantize to 4-bit affine. Measured equivalent to bf16 on acceptance
 *      (2.27 vs 2.35 accepted tokens/round) and byte-identical under greedy
 *      exactness, at 247 MB instead of 849 MB.
 *
 * Usage:
 *   node scripts/build-mtp-drafter.mjs \
 *     --source Qwen/Qwen3.8-27B --out ~/.gezel-dev/engines/mlx/drafters/qwen3.8-27b-q4-mtp
 *
 * Options: --bits 4 (0 = keep bf16), --python <venv python>, --keep-source.
 * Requires an MLX venv with mlx-vlm >= 0.6.17 (the pinned line; older MTP
 * verify is measured-inexact — see reports/mlx-mtp-rig-20260828.md).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const SOURCE = opt('source', 'Qwen/Qwen3.8-27B');
const OUT = opt('out', '').replace(/^~/, homedir());
const BITS = Number(opt('bits', '4'));
const PYTHON = opt('python', join(homedir(), '.gezel-dev/engines/uv/venvs/mlx/bin/python'));
const KEEP = args.includes('--keep-source');

if (!OUT) {
  console.error('--out <drafter dir> is required');
  process.exit(2);
}
if (!existsSync(PYTHON)) {
  console.error(`no MLX python at ${PYTHON} (pass --python)`);
  process.exit(2);
}

const HF = 'https://huggingface.co';
const GEZEL_REPO = 'https://github.com/bendyline/gezel';
const fetchText = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return r.text();
};

const staging = mkdtempSync(join(tmpdir(), 'mtp-src-'));
try {
  console.log(`[1/3] resolving ${SOURCE} weight index…`);
  const index = JSON.parse(
    await fetchText(`${HF}/${SOURCE}/resolve/main/model.safetensors.index.json`),
  );
  const shards = [
    ...new Set(
      Object.entries(index.weight_map)
        .filter(([k]) => k.startsWith('mtp.'))
        .map(([, v]) => v),
    ),
  ];
  if (!shards.length) {
    throw new Error(
      `${SOURCE} has no mtp.* tensors — it is not an MTP-preserving checkpoint. ` +
        'Use the ORIGINAL vendor repo, not an MLX/GGUF conversion.',
    );
  }
  const mtpCount = Object.keys(index.weight_map).filter((k) => k.startsWith('mtp.')).length;
  console.log(
    `      ${mtpCount} mtp tensors in ${shards.length} of ${new Set(Object.values(index.weight_map)).size} shards`,
  );

  // The splitter reads config.json + the index to find the head; tokenizer
  // files ride along into the drafter so it is self-describing.
  const support = [
    'config.json',
    'model.safetensors.index.json',
    'tokenizer.json',
    'tokenizer_config.json',
  ];
  for (const name of [...support, ...shards]) {
    process.stdout.write(`      fetching ${name}… `);
    execFileSync('curl', [
      '-sLf',
      '--retry',
      '3',
      `${HF}/${SOURCE}/resolve/main/${name}`,
      '-o',
      join(staging, name),
    ]);
    console.log('ok');
  }

  console.log('[2/3] splitting the MTP head…');
  const bf16Out = BITS > 0 ? `${OUT}.bf16` : OUT;
  execFileSync(
    PYTHON,
    [
      '-m',
      'mlx_vlm.speculative.drafters.qwen3_5_mtp.split',
      '--model',
      staging,
      '--output',
      bf16Out,
    ],
    { stdio: 'inherit' },
  );

  if (BITS > 0) {
    console.log(`[3/3] quantizing to ${BITS}-bit…`);
    mkdirSync(OUT, { recursive: true });
    const py = `
import json, shutil, sys
from pathlib import Path
import mlx.core as mx, mlx.nn as nn
from mlx.utils import tree_flatten
from mlx_vlm.speculative.drafters import load_drafter
src, dst, bits, group = Path(sys.argv[1]), Path(sys.argv[2]), ${BITS}, 64
model, kind = load_drafter(str(src))
nn.quantize(model, group_size=group, bits=bits)
mx.save_safetensors(str(dst / "model.safetensors"), dict(tree_flatten(model.parameters())), metadata={"format": "mlx"})
cfg = json.loads((src / "config.json").read_text())
q = {"group_size": group, "bits": bits, "mode": "affine"}
cfg["quantization"] = q; cfg["quantization_config"] = q
(dst / "config.json").write_text(json.dumps(dict(sorted(cfg.items())), indent=2))
for n in ("tokenizer.json", "tokenizer_config.json", "vocab.json"):
    if (src / n).exists(): shutil.copy(src / n, dst / n)
print(f"  kind={kind} quantized to {bits}-bit")
`;
    execFileSync(PYTHON, ['-c', py, bf16Out, OUT], { stdio: 'inherit' });
    if (!KEEP) rmSync(bf16Out, { recursive: true, force: true });
  }

  // Attribution travels with the artifact: the weights are a derivative of the
  // source checkpoint and carry its license.
  writeFileSync(
    join(OUT, 'README.md'),
    `---\nbase_model: ${SOURCE}\nlicense: apache-2.0\nlibrary_name: mlx\ntags:\n- mlx\n- speculative-decoding\n- mtp\n---\n\n` +
      `# MTP drafter for ${SOURCE}\n\n` +
      `The native multi-token-prediction head of [${SOURCE}](${HF}/${SOURCE}), extracted as a\n` +
      `standalone MLX drafter${BITS > 0 ? ` and quantized to ${BITS}-bit affine (group 64)` : ''}.\n` +
      `It carries no embedding or LM head of its own — it binds to the target model's at load,\n` +
      `so it pairs with any quantization of the same base model.\n\n` +
      `Speculative decoding verifies every proposed token against the target model, so this\n` +
      `drafter changes throughput only, never output: greedy decoding is byte-identical with\n` +
      `and without it.\n\n` +
      `## Reproducing\n\nBuilt by [\`scripts/build-mtp-drafter.mjs\`](${GEZEL_REPO}/blob/main/scripts/build-mtp-drafter.mjs)\n` +
      `from [Gezel](${GEZEL_REPO}) — a local-first desktop app for assembling a team of AI agents that\n` +
      `run on your own machine:\n\n` +
      `\`\`\`bash\ngit clone ${GEZEL_REPO}.git\n` +
      `node scripts/build-mtp-drafter.mjs --source ${SOURCE} --out <dir>${BITS !== 4 ? ` --bits ${BITS}` : ''}\n\`\`\`\n\n` +
      `The script fetches only the checkpoint shard(s) carrying the \`mtp.*\` tensors (1 of 18 for this\n` +
      `model), splits the head into a standalone drafter${BITS > 0 ? `, and quantizes it to ${BITS}-bit` : ''}.\n\n` +
      `## License\n\nApache-2.0, inherited from ${SOURCE}. Weights are a derivative of that checkpoint.\n`,
    'utf8',
  );

  console.log(`\ndrafter written to ${OUT}`);
  console.log('verify before publishing: acceptance + greedy exactness against the target model.');
} finally {
  if (!KEEP) rmSync(staging, { recursive: true, force: true });
}
