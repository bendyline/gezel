/**
 * Minimal type surface required by Transformers.js's generated image
 * declarations. Runtime calls always throw because Gezel does not bundle its
 * vision pipelines.
 */
declare function sharp(...args: unknown[]): never;

declare namespace sharp {
  type Sharp = never;
  const gezelSharpCompatibilityStub: true;
}

export = sharp;
