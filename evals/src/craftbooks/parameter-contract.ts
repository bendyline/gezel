import {
  craftbookParamDefaults,
  interpolateContextDeep,
  isRuntimeTemplateDefault,
  paramAsksUser,
  resolveCraftbookParamDefaults,
  resolveRuntimeTokensInParams,
} from '@bendyline/gezel';
import type {
  CraftbookEvalSpec,
  CraftbookTemplateStepSummary,
  CraftbookTemplateSummary,
} from './types.ts';

export type CraftbookParameterFindingSeverity = 'warn' | 'fail';

export type CraftbookParameterFindingCode =
  | 'param.unsupported-type'
  | 'param.visible-missing-title'
  | 'param.visible-missing-description'
  | 'param.unintended-hidden-template-default'
  | 'test.undeclared-param'
  | 'test.missing-required-param'
  | 'path.unresolved-token';

export interface CraftbookParameterContractFinding {
  craftbookId: string;
  scenarioId?: string;
  severity: CraftbookParameterFindingSeverity;
  code: CraftbookParameterFindingCode;
  message: string;
  param?: string;
  path?: string;
  token?: string;
}

export interface CraftbookParameterContractSummary {
  checked: number;
  clean: number;
  withFindings: number;
  failures: number;
  warnings: number;
  byCode: Partial<Record<CraftbookParameterFindingCode, number>>;
  findings: CraftbookParameterContractFinding[];
}

/**
 * Parameters added by connector launch preparation rather than by the launch
 * form. Keep this deliberately explicit: accepting every unknown token on a
 * connector-backed book would hide ordinary spelling mistakes in its gates.
 */
export const DEFAULT_CONNECTOR_RUNTIME_PARAMS: Readonly<Record<string, readonly string[]>> = {
  'github-pulls': ['number', 'corpusScope'],
};

export interface CraftbookParameterAuditOptions {
  connectorRuntimeParams?: Readonly<Record<string, readonly string[]>>;
}

type ParamProperty = Record<string, unknown>;

const TOKEN_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
const RUNTIME_CONTEXT: Readonly<Record<string, string>> = {
  'task.num': '1',
  'task.ref': 'eval-project/1',
  'task.projectId': 'eval-project',
  'task.dir': 'tasks/1',
  'diffpack.id': '1',
  'diffpack.dir': 'diffpacks/1',
};

function paramProperties(template: CraftbookTemplateSummary): Record<string, ParamProperty> {
  const raw = template.paramSchema?.properties;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(
      (entry): entry is [string, ParamProperty] =>
        !!entry[1] && typeof entry[1] === 'object' && !Array.isArray(entry[1]),
    ),
  );
}

function requiredParams(template: CraftbookTemplateSummary): string[] {
  const required = template.paramSchema?.required;
  return Array.isArray(required)
    ? required.filter((key): key is string => typeof key === 'string')
    : [];
}

function connectorParams(
  template: CraftbookTemplateSummary,
  options: CraftbookParameterAuditOptions,
): Set<string> {
  const registry = options.connectorRuntimeParams ?? DEFAULT_CONNECTOR_RUNTIME_PARAMS;
  return new Set(
    (template.connectors ?? []).flatMap((connector) => registry[connector.typeId] ?? []),
  );
}

function hasScalarDefault(property: ParamProperty): boolean {
  return ['string', 'number', 'boolean'].includes(typeof property.default);
}

function unsupportedTypes(property: ParamProperty): string[] {
  const raw = property.type;
  const types = Array.isArray(raw) ? raw : [raw];
  return types.filter((type): type is string => type === 'object');
}

function projectPropertyValue(property: ParamProperty): string | undefined {
  return typeof property.projectProperty === 'string' && property.projectProperty.trim()
    ? `project-property:${property.projectProperty}`
    : undefined;
}

function finding(
  template: CraftbookTemplateSummary,
  spec: CraftbookEvalSpec | undefined,
  value: Omit<CraftbookParameterContractFinding, 'craftbookId' | 'scenarioId'>,
): CraftbookParameterContractFinding {
  return {
    craftbookId: template.id,
    ...(spec ? { scenarioId: spec.scenarioId } : {}),
    ...value,
  };
}

function auditSchema(
  template: CraftbookTemplateSummary,
  spec: CraftbookEvalSpec | undefined,
): CraftbookParameterContractFinding[] {
  const findings: CraftbookParameterContractFinding[] = [];
  for (const [param, property] of Object.entries(paramProperties(template))) {
    const unsupported = unsupportedTypes(property);
    if (unsupported.length > 0) {
      findings.push(
        finding(template, spec, {
          severity: 'fail',
          code: 'param.unsupported-type',
          param,
          message: `Parameter "${param}" uses ${unsupported.join('/')} values, but craftbook launch parameters serialize only scalars and flat scalar arrays.`,
        }),
      );
    }

    if (paramAsksUser(property, param)) {
      if (typeof property.title !== 'string' || !property.title.trim()) {
        findings.push(
          finding(template, spec, {
            severity: 'warn',
            code: 'param.visible-missing-title',
            param,
            message: `Visible parameter "${param}" has no title.`,
          }),
        );
      }
      if (typeof property.description !== 'string' || !property.description.trim()) {
        findings.push(
          finding(template, spec, {
            severity: 'warn',
            code: 'param.visible-missing-description',
            param,
            message: `Visible parameter "${param}" has no description.`,
          }),
        );
      }
    }

    // `workPath` is the established runtime-owned convention. Every other
    // templated default must make its visibility intentional with askUser;
    // otherwise merely adding `{{task.num}}` silently removes a useful form
    // field (including fields whose own description says users may override).
    if (
      param !== 'workPath' &&
      property.askUser === undefined &&
      isRuntimeTemplateDefault(property.default) &&
      !paramAsksUser(property, param)
    ) {
      findings.push(
        finding(template, spec, {
          severity: 'warn',
          code: 'param.unintended-hidden-template-default',
          param,
          message: `Parameter "${param}" is hidden only because its default contains a template token; set askUser explicitly to document whether that is intended.`,
        }),
      );
    }
  }
  return findings;
}

function auditFixture(
  template: CraftbookTemplateSummary,
  spec: CraftbookEvalSpec | undefined,
  connectorProvided: ReadonlySet<string>,
): CraftbookParameterContractFinding[] {
  if (!spec) return [];
  const findings: CraftbookParameterContractFinding[] = [];
  const properties = paramProperties(template);
  const fixture = spec.setup?.craftbookParams ?? {};

  for (const param of Object.keys(fixture)) {
    if (properties[param]) continue;
    findings.push(
      finding(template, spec, {
        severity: 'fail',
        code: 'test.undeclared-param',
        param,
        message: `Eval fixture supplies undeclared craftbook parameter "${param}".`,
      }),
    );
  }

  for (const param of requiredParams(template)) {
    const property = properties[param] ?? {};
    const suppliedByFixture = Object.prototype.hasOwnProperty.call(fixture, param);
    const suppliedByInput = property.input != null && suppliedByFixture;
    const suppliedByProject = projectPropertyValue(property) !== undefined;
    if (
      suppliedByFixture ||
      suppliedByInput ||
      hasScalarDefault(property) ||
      suppliedByProject ||
      connectorProvided.has(param)
    ) {
      continue;
    }
    findings.push(
      finding(template, spec, {
        severity: 'fail',
        code: 'test.missing-required-param',
        param,
        message: `Eval fixture does not provide required craftbook parameter "${param}".`,
      }),
    );
  }
  return findings;
}

function interpolationContext(
  template: CraftbookTemplateSummary,
  spec: CraftbookEvalSpec | undefined,
  connectorProvided: ReadonlySet<string>,
): Record<string, string> {
  const fixture = spec?.setup?.craftbookParams ?? {};
  const generated: Record<string, string> = {};
  for (const [param, property] of Object.entries(paramProperties(template))) {
    const value = projectPropertyValue(property);
    if (value !== undefined) generated[param] = value;
  }
  for (const param of connectorProvided) generated[param] = `connector:${param}`;
  const overrides = resolveRuntimeTokensInParams({ ...generated, ...fixture }, RUNTIME_CONTEXT);
  return {
    ...resolveCraftbookParamDefaults(
      craftbookParamDefaults(template.paramSchema),
      overrides,
      RUNTIME_CONTEXT,
    ),
    ...overrides,
    ...RUNTIME_CONTEXT,
  };
}

interface InterpolationSurface {
  path: string;
  value: unknown;
  spawnItemContext?: boolean;
}

function stepSurfaces(
  step: CraftbookTemplateStepSummary,
  prefix: string,
  spawnItemContext = false,
): InterpolationSurface[] {
  return [
    { path: `${prefix}.advanceWhen`, value: step.advanceWhen, spawnItemContext },
    { path: `${prefix}.gate`, value: step.gate, spawnItemContext },
    { path: `${prefix}.onEnter`, value: step.onEnter, spawnItemContext },
    { path: `${prefix}.onExit`, value: step.onExit, spawnItemContext },
    { path: `${prefix}.consumes`, value: step.consumes, spawnItemContext },
  ].filter((surface) => surface.value !== undefined);
}

function interpolationSurfaces(template: CraftbookTemplateSummary): InterpolationSurface[] {
  const surfaces = template.steps.flatMap((step, index) => stepSurfaces(step, `steps[${index}]`));
  if (!template.spawn) return surfaces;
  surfaces.push({ path: 'spawn.overFile', value: template.spawn.overFile });
  surfaces.push(
    ...template.spawn.steps.flatMap((step, index) =>
      stepSurfaces(step, `spawn.steps[${index}]`, true),
    ),
  );
  return surfaces;
}

interface TokenOccurrence {
  token: string;
  path: string;
}

function unresolvedTokens(value: unknown, path: string, out: TokenOccurrence[]): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(TOKEN_PATTERN)) {
      if (match[1]) out.push({ token: match[1], path });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => unresolvedTokens(item, `${path}[${index}]`, out));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    unresolvedTokens(child, `${path}.${key}`, out);
  }
}

function auditInterpolatedSurfaces(
  template: CraftbookTemplateSummary,
  spec: CraftbookEvalSpec | undefined,
  connectorProvided: ReadonlySet<string>,
): CraftbookParameterContractFinding[] {
  const context = interpolationContext(template, spec, connectorProvided);
  const declared = new Set(Object.keys(paramProperties(template)));
  const findings: CraftbookParameterContractFinding[] = [];

  for (const surface of interpolationSurfaces(template)) {
    const resolved = interpolateContextDeep(surface.value, context);
    const occurrences: TokenOccurrence[] = [];
    unresolvedTokens(resolved, surface.path, occurrences);
    for (const occurrence of occurrences) {
      // A spawn child's item is arbitrary JSON. Unknown fields are therefore
      // valid child context, while a declared-but-unresolved param is still a
      // broken launch contract and must not be waved through as item data.
      if (surface.spawnItemContext && !declared.has(occurrence.token)) continue;
      findings.push(
        finding(template, spec, {
          severity: 'fail',
          code: 'path.unresolved-token',
          path: occurrence.path,
          token: occurrence.token,
          message: `Runtime gate/path field ${occurrence.path} still contains unresolved token "{{${occurrence.token}}}" after defaults and eval parameters are applied.`,
        }),
      );
    }
  }
  return findings;
}

function dedupeFindings(
  findings: readonly CraftbookParameterContractFinding[],
): CraftbookParameterContractFinding[] {
  const unique = new Map<string, CraftbookParameterContractFinding>();
  for (const item of findings) {
    const key = [
      item.craftbookId,
      item.code,
      item.param ?? '',
      item.path ?? '',
      item.token ?? '',
    ].join('\0');
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()].sort(
    (a, b) =>
      a.craftbookId.localeCompare(b.craftbookId) ||
      a.code.localeCompare(b.code) ||
      (a.param ?? a.path ?? '').localeCompare(b.param ?? b.path ?? ''),
  );
}

/** Audit the launcher, fixture, and runtime interpolation contracts together. */
export function auditCraftbookParameterContracts(
  specs: readonly CraftbookEvalSpec[],
  templates: readonly CraftbookTemplateSummary[],
  options: CraftbookParameterAuditOptions = {},
): CraftbookParameterContractSummary {
  const specsById = new Map(specs.map((spec) => [spec.craftbookId, spec]));
  const all: CraftbookParameterContractFinding[] = [];
  for (const template of templates) {
    const spec = specsById.get(template.id);
    const provided = connectorParams(template, options);
    all.push(
      ...auditSchema(template, spec),
      ...auditFixture(template, spec, provided),
      ...auditInterpolatedSurfaces(template, spec, provided),
    );
  }
  const findings = dedupeFindings(all);
  const affected = new Set(findings.map((item) => item.craftbookId));
  const byCode: CraftbookParameterContractSummary['byCode'] = {};
  for (const item of findings) byCode[item.code] = (byCode[item.code] ?? 0) + 1;
  return {
    checked: templates.length,
    clean: templates.length - affected.size,
    withFindings: affected.size,
    failures: findings.filter((item) => item.severity === 'fail').length,
    warnings: findings.filter((item) => item.severity === 'warn').length,
    byCode,
    findings,
  };
}
