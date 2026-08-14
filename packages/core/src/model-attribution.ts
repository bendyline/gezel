import type { ChatModelManifest } from './schemas/catalog.js';

export interface ModelAttribution {
  /** The organization that created the underlying model. */
  maker: string;
  /** Organizations that published converted, quantized, or otherwise customized builds. */
  customizers: string[];
}

type AttributableChatModel = Pick<
  ChatModelManifest,
  'maintainer' | 'maker' | 'upstream' | 'llamaCpp' | 'mlx' | 'ds4'
>;

/**
 * Describe who made a catalog chat model and who prepared its downloadable
 * variants. An explicit `maker` wins; older catalog data falls back to the
 * maintainer/upstream relationship. Hugging Face repository owners identify
 * the organizations that published engine-specific conversions. Owners that
 * are aliases of the maker are omitted.
 */
export function modelAttribution(manifest: AttributableChatModel): ModelAttribution {
  const sourceOwners = [
    manifest.llamaCpp?.huggingfaceRepo,
    manifest.mlx?.huggingfaceRepo,
    manifest.ds4?.huggingfaceRepo,
  ]
    .map((repo) => (repo ? huggingFaceOwnerFromRepo(repo) : null))
    .filter((owner): owner is string => owner !== null);
  const explicitMakerOwner = manifest.maker?.url
    ? huggingFaceOwnerFromUrl(manifest.maker.url)
    : null;
  const maintainerOwner = manifest.maintainer.url
    ? huggingFaceOwnerFromUrl(manifest.maintainer.url)
    : null;
  const upstreamOwner = manifest.upstream ? huggingFaceOwnerFromUrl(manifest.upstream) : null;
  const normalizedSources = new Set(sourceOwners.map(normalizeOrganization));
  const maintainerIsSource = [manifest.maintainer.name, maintainerOwner]
    .filter((name): name is string => name !== null)
    .some((name) => normalizedSources.has(normalizeOrganization(name)));
  const upstreamIsSource = upstreamOwner
    ? normalizedSources.has(normalizeOrganization(upstreamOwner))
    : false;

  // Some catalog entries are maintained by the person who prepared a special
  // quant (rather than by the core model company). When that maintainer also
  // owns the downloadable source and the upstream points elsewhere, the
  // upstream organization is the maker and the maintainer remains a customizer.
  const makerFromUpstream =
    !manifest.maker && maintainerIsSource && upstreamOwner && !upstreamIsSource;
  const maker =
    manifest.maker?.name ??
    (makerFromUpstream ? displayOrganizationName(upstreamOwner) : manifest.maintainer.name);
  const makerAliases = new Set<string>([normalizeOrganization(maker)]);
  if (explicitMakerOwner) makerAliases.add(normalizeOrganization(explicitMakerOwner));
  if (upstreamOwner) makerAliases.add(normalizeOrganization(upstreamOwner));
  if (!manifest.maker && !makerFromUpstream) {
    makerAliases.add(normalizeOrganization(manifest.maintainer.name));
    if (maintainerOwner) makerAliases.add(normalizeOrganization(maintainerOwner));
  }

  const customizers: string[] = [];
  const seen = new Set<string>();
  const customizerCandidates = manifest.maker
    ? [manifest.maintainer.name, ...sourceOwners]
    : sourceOwners;
  for (const owner of customizerCandidates) {
    const normalized = normalizeOrganization(owner);
    if (!normalized || makerAliases.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    customizers.push(owner);
  }

  return { maker, customizers };
}

function displayOrganizationName(owner: string): string {
  // These are account slugs whose public brand names cannot be recovered by
  // generic title-casing. Unknown owners remain recognizable as their source
  // account instead of inventing a company name.
  const knownNames: Record<string, string> = {
    'deepseek-ai': 'DeepSeek',
    'zai-org': 'Z.ai',
  };
  return knownNames[owner.toLowerCase()] ?? owner;
}

/** Compact attribution for terminal labels and other one-line surfaces. */
export function formatModelAttribution(manifest: AttributableChatModel): string {
  const attribution = modelAttribution(manifest);
  return attribution.customizers.length > 0
    ? `${attribution.maker}, customized by ${attribution.customizers.join(', ')}`
    : attribution.maker;
}

function huggingFaceOwnerFromRepo(repo: string): string | null {
  const slash = repo.indexOf('/');
  return slash > 0 ? repo.slice(0, slash) : null;
}

function huggingFaceOwnerFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== 'huggingface.co') return null;
    const owner = url.pathname.split('/').filter(Boolean)[0];
    return owner ?? null;
  } catch {
    return null;
  }
}

function normalizeOrganization(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}
