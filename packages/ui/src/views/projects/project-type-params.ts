import type { SquisqAnnotatedSchema } from '@bendyline/squisq';

type Properties = Record<string, SquisqAnnotatedSchema>;

function propertiesOf(schema: SquisqAnnotatedSchema | undefined): Properties {
  return (schema?.properties ?? {}) as Properties;
}

/** The values a project type's text falls back to when a question is left unanswered. */
export function projectTypeParamDefaults(
  schema: SquisqAnnotatedSchema | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(propertiesOf(schema))) {
    if (prop.default !== undefined) out[key] = prop.default;
  }
  return out;
}

/** A question answered by typing: a string with no choices, format or chosen control. */
function isFreeText(prop: SquisqAnnotatedSchema): boolean {
  return (
    prop.type === 'string' &&
    !prop.enum &&
    prop.const === undefined &&
    !prop.format &&
    !prop.squisq?.control
  );
}

function isCurrency(key: string, prop: SquisqAnnotatedSchema): boolean {
  return (
    prop.type === 'string' && !prop.enum && (prop.format === 'currency' || /^currency$/i.test(key))
  );
}

/** Common ISO 4217 codes, by code. A type's own default joins them when missing. */
const CURRENCIES: ReadonlyArray<readonly [string, string]> = [
  ['AED', 'UAE dirham'],
  ['ARS', 'Argentine peso'],
  ['AUD', 'Australian dollar'],
  ['BDT', 'Bangladeshi taka'],
  ['BGN', 'Bulgarian lev'],
  ['BRL', 'Brazilian real'],
  ['CAD', 'Canadian dollar'],
  ['CHF', 'Swiss franc'],
  ['CLP', 'Chilean peso'],
  ['CNY', 'Chinese yuan'],
  ['COP', 'Colombian peso'],
  ['CZK', 'Czech koruna'],
  ['DKK', 'Danish krone'],
  ['EGP', 'Egyptian pound'],
  ['EUR', 'Euro'],
  ['GBP', 'British pound'],
  ['GHS', 'Ghanaian cedi'],
  ['HKD', 'Hong Kong dollar'],
  ['HUF', 'Hungarian forint'],
  ['IDR', 'Indonesian rupiah'],
  ['ILS', 'Israeli new shekel'],
  ['INR', 'Indian rupee'],
  ['ISK', 'Icelandic krona'],
  ['JPY', 'Japanese yen'],
  ['KES', 'Kenyan shilling'],
  ['KRW', 'South Korean won'],
  ['MAD', 'Moroccan dirham'],
  ['MXN', 'Mexican peso'],
  ['MYR', 'Malaysian ringgit'],
  ['NGN', 'Nigerian naira'],
  ['NOK', 'Norwegian krone'],
  ['NZD', 'New Zealand dollar'],
  ['PEN', 'Peruvian sol'],
  ['PHP', 'Philippine peso'],
  ['PKR', 'Pakistani rupee'],
  ['PLN', 'Polish zloty'],
  ['RON', 'Romanian leu'],
  ['SAR', 'Saudi riyal'],
  ['SEK', 'Swedish krona'],
  ['SGD', 'Singapore dollar'],
  ['THB', 'Thai baht'],
  ['TRY', 'Turkish lira'],
  ['TWD', 'New Taiwan dollar'],
  ['UAH', 'Ukrainian hryvnia'],
  ['USD', 'US dollar'],
  ['VND', 'Vietnamese dong'],
  ['ZAR', 'South African rand'],
];

function currencyQuestion(prop: SquisqAnnotatedSchema): SquisqAnnotatedSchema {
  const fallback = typeof prop.default === 'string' ? prop.default.trim().toUpperCase() : '';
  const known = new Map<string, string>(CURRENCIES);
  const codes = [...known.keys()];
  if (fallback && !known.has(fallback)) codes.unshift(fallback);
  const enumLabels: Record<string, string> = {};
  for (const code of codes) {
    const name = known.get(code);
    enumLabels[code] = name ? `${code} — ${name}` : code;
  }
  // The type's own help ("a three-letter code") describes typing, which a
  // list replaces; the labels name each currency.
  const { description: _typedHelp, ...rest } = prop;
  return {
    ...rest,
    ...(fallback ? { default: fallback } : {}),
    enum: fallback ? codes : ['', ...codes],
    squisq: {
      ...prop.squisq,
      control: 'combobox',
      enumLabels: fallback ? enumLabels : { '': 'Choose a currency', ...enumLabels },
    },
  };
}

/**
 * The form a person fills in for a project type, and its starting values.
 *
 * A typed answer's default is the stand-in the type's text falls back to
 * ("the business", "our home"), so it shows as a hint in an empty field
 * instead of as an answer the person never gave; leaving the field empty
 * still uses it. A currency is chosen from a list, starting on the type's
 * default, instead of typed as a code.
 */
export function projectTypeParamForm(schema: SquisqAnnotatedSchema | undefined): {
  schema: SquisqAnnotatedSchema | undefined;
  initial: Record<string, unknown>;
} {
  if (!schema?.properties) return { schema, initial: projectTypeParamDefaults(schema) };
  const properties: Properties = {};
  const initial: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(propertiesOf(schema))) {
    if (isCurrency(key, prop)) {
      const question = currencyQuestion(prop);
      properties[key] = question;
      if (question.default !== undefined) initial[key] = question.default;
    } else if (isFreeText(prop)) {
      const hint =
        prop.squisq?.placeholder ??
        (typeof prop.examples?.[0] === 'string' ? prop.examples[0] : undefined) ??
        (typeof prop.default === 'string' ? prop.default : undefined);
      properties[key] = hint ? { ...prop, squisq: { ...prop.squisq, placeholder: hint } } : prop;
    } else {
      properties[key] = prop;
      if (prop.default !== undefined) initial[key] = prop.default;
    }
  }
  return { schema: { ...schema, properties }, initial };
}

/**
 * What a typed project is created with: the person's answers over the
 * type's defaults, where a field left blank counts as unanswered.
 */
export function projectTypeParamsForSubmit(
  schema: SquisqAnnotatedSchema | undefined,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out = projectTypeParamDefaults(schema);
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.trim() === '' && out[key] !== undefined) continue;
    out[key] = value;
  }
  return out;
}
