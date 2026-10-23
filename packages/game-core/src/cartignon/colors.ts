/**
 * Card colors and the color cycle (RD-01). The cycle is data, not code: rules code asks
 * `beats(rules, a, b)` and never hardcodes which color counters which.
 */

/** RD-01: canonical color order. */
export const COLORS = ['orange', 'yellow', 'green', 'blue', 'indigo', 'violet', 'red'] as const;

export type Color = (typeof COLORS)[number];

/** Map from each color to the single color it beats (counters). */
export type ColorRules = Readonly<Record<Color, Color>>;

export function isColor(value: unknown): value is Color {
  return typeof value === 'string' && (COLORS as readonly string[]).includes(value);
}

/** RD-01 default: each color beats the next one in `COLORS`; the last (red) beats the first. */
export const DEFAULT_COLOR_RULES: ColorRules = Object.freeze({
  orange: 'yellow',
  yellow: 'green',
  green: 'blue',
  blue: 'indigo',
  indigo: 'violet',
  violet: 'red',
  red: 'orange',
});

/** True when color `a` beats color `b`. Every other pair is neutral (RD-01). */
export function beats(rules: ColorRules, a: Color, b: Color): boolean {
  return rules[a] === b;
}

/**
 * The single color that beats `c`. Throws only if `rules` was never validated (programmer
 * error): valid rules always have exactly one answer.
 */
export function beatenBy(rules: ColorRules, c: Color): Color {
  const found = COLORS.filter((x) => rules[x] === c);
  const [only] = found;
  if (found.length !== 1 || only === undefined) {
    throw new Error(`Invalid color rules: ${found.length} colors beat ${c}`);
  }
  return only;
}

export type ColorRulesResult =
  | { readonly ok: true; readonly value: ColorRules }
  | { readonly ok: false; readonly code: 'INVALID_COLOR_RULES'; readonly message: string };

/**
 * Validates untrusted color-rules config (RD-01): an object with exactly the seven colors as
 * keys, where each color beats exactly one other color, is beaten by exactly one, never
 * beats itself, and no two colors beat each other. Returns a fresh frozen copy on success.
 */
export function validateColorRules(input: unknown): ColorRulesResult {
  const fail = (message: string): ColorRulesResult => ({
    ok: false,
    code: 'INVALID_COLOR_RULES',
    message,
  });
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail('Color rules must be an object');
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!isColor(key)) return fail(`Unknown color key: ${key}`);
  }
  const out = {} as Record<Color, Color>;
  const beatenCount = new Map<Color, number>();
  for (const color of COLORS) {
    const target = record[color];
    if (target === undefined) return fail(`Missing entry for ${color}`);
    if (!isColor(target)) return fail(`${color} must beat a known color`);
    if (target === color) return fail(`${color} must not beat itself`);
    out[color] = target;
    beatenCount.set(target, (beatenCount.get(target) ?? 0) + 1);
  }
  for (const color of COLORS) {
    const n = beatenCount.get(color) ?? 0;
    if (n !== 1) return fail(`${color} must be beaten by exactly one color, found ${n}`);
  }
  // RD-01: a color is neutral vs the four colors it neither beats nor is beaten by, so two
  // colors may not beat each other. A single 7-cycle is NOT required (not a confirmed rule).
  for (const color of COLORS) {
    if (out[out[color]] === color) {
      return fail(`${color} and ${out[color]} must not beat each other`);
    }
  }
  return { ok: true, value: Object.freeze(out) };
}
