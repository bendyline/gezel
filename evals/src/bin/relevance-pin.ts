/**
 * `pnpm --filter @bendyline/gezel-evals exec tsx src/bin/relevance-pin.ts -- --repo <org/name> --revision <sha> --graph onnx/<file>.onnx --id <id@1> [--upstream <org/name>]`
 *
 * Print a relevance-model registry entry pinned at an exact revision: every
 * file's sha256 and size (LFS digests from the Hugging Face API, small files
 * downloaded and hashed), with the architecture and score activation read
 * from `config.json` and the license checked against the allowlist — on the
 * repo, or on the upstream a port names. Nothing is written: a person reviews
 * the entry and pastes it into packages/service/src/relevance/registry.ts.
 */
import { createHash } from 'node:crypto';
import { parseArgs } from './args.ts';

const LICENSE_ALLOWLIST = new Set(['apache-2.0', 'mit', 'bsd-3-clause']);
const SUPPORTED_ARCHITECTURES = new Set([
  'bert',
  'xlm-roberta',
  'deberta-v2',
  'roberta',
  'electra',
  'distilbert',
]);
const COMPANION_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json'];

interface HfSibling {
  rfilename: string;
  size?: number;
  lfs?: { sha256: string; size: number };
}

async function modelInfo(repo: string, revision: string) {
  const res = await fetch(
    `https://huggingface.co/api/models/${repo}/revision/${revision}?blobs=true`,
  );
  if (!res.ok) throw new Error(`${repo}@${revision}: HTTP ${res.status}`);
  return (await res.json()) as {
    sha: string;
    siblings: HfSibling[];
    cardData?: { license?: string };
  };
}

async function download(repo: string, revision: string, path: string): Promise<Buffer> {
  const res = await fetch(`https://huggingface.co/${repo}/resolve/${revision}/${path}`);
  if (!res.ok) throw new Error(`${repo}/${path}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const repo = String(flags.repo ?? '');
  const revision = String(flags.revision ?? '');
  const graph = String(flags.graph ?? '');
  const id = String(flags.id ?? '');
  const upstream = flags.upstream ? String(flags.upstream) : undefined;
  if (!repo || !/^[0-9a-f]{40}$/.test(revision) || !graph.endsWith('.onnx') || !id) {
    console.error('need --repo, a 40-hex --revision, --graph onnx/<file>.onnx, and --id');
    process.exit(2);
  }
  const info = await modelInfo(repo, revision);
  const license =
    (upstream ? (await modelInfo(upstream, 'main')).cardData?.license : info.cardData?.license) ??
    '';
  if (!LICENSE_ALLOWLIST.has(license.toLowerCase())) {
    throw new Error(
      `license "${license || 'none'}" is not on the allowlist (${[...LICENSE_ALLOWLIST].join(', ')})`,
    );
  }
  const config = JSON.parse((await download(repo, revision, 'config.json')).toString('utf8')) as {
    model_type?: string;
    architectures?: string[];
    num_labels?: number;
    id2label?: Record<string, string>;
  };
  if (!config.model_type || !SUPPORTED_ARCHITECTURES.has(config.model_type)) {
    throw new Error(`model_type ${config.model_type} is not a supported sequence classifier`);
  }
  if (!config.architectures?.[0]?.endsWith('ForSequenceClassification')) {
    throw new Error(`architecture ${config.architectures?.[0]} is not a sequence classifier`);
  }
  const labels = config.num_labels ?? Object.keys(config.id2label ?? {}).length ?? 1;
  const files: Array<{ path: string; sha256: string; bytes: number }> = [];
  for (const path of [...COMPANION_FILES, graph]) {
    const sibling = info.siblings.find((s) => s.rfilename === path);
    if (!sibling) throw new Error(`${repo}@${revision} has no ${path}`);
    if (sibling.lfs) {
      files.push({ path, sha256: sibling.lfs.sha256, bytes: sibling.lfs.size });
    } else {
      const bytes = await download(repo, revision, path);
      files.push({
        path,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
      });
    }
  }
  const entry = {
    id,
    displayName: '<fill in>',
    description: '<fill in: plain language>',
    source: { repo, revision, ...(upstream ? { upstream } : {}) },
    license: {
      spdx: license === 'apache-2.0' ? 'Apache-2.0' : license.toUpperCase(),
      url: `https://huggingface.co/${upstream ?? repo}`,
    },
    languages: ['<fill in>'],
    architecture: config.model_type,
    files,
    graph,
    approxBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    maxTokens: 512,
    queryMaxTokens: 96,
    scoreActivation: labels <= 1 ? 'sigmoid' : 'softmax-positive',
    thresholds: null,
    calibration: null,
  };
  console.log(JSON.stringify(entry, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
