/** @typedef {'advanced' | 'medium' | 'needs-improvement'} CategoryId */

// Matches the institution scale enforced by erp.academics.cgpa's CHECK constraint.
// Keep decimal boundaries as strings: PostgreSQL numeric comparisons stay exact.
export const CGPA_SCALE = Object.freeze({ min: "0", max: "10" });
/** @type {ReadonlyArray<Readonly<{id: CategoryId, name: string, minimum: string|null, displayRange: string, conditionLabel: string}>>} */
export const CATEGORY_RULES = Object.freeze([
  Object.freeze({
    id: "advanced",
    name: "Advanced",
    minimum: "8.50",
    displayRange: "8.50 and above",
    conditionLabel: "8.50 and above",
  }),
  Object.freeze({
    id: "medium",
    name: "Medium",
    minimum: "6.75",
    displayRange: "6.75 – 8.49",
    conditionLabel: "6.75 to below 8.50",
  }),
  Object.freeze({
    id: "needs-improvement",
    name: "Needs Improvement",
    minimum: null,
    displayRange: "Below 6.75",
    conditionLabel: "Below 6.75",
  }),
]);

// Statistical bands are intentionally separate from the performance categories.
export const DISTRIBUTION_BANDS = Object.freeze([
  { id: "under-six", label: "Below 6.0", lower: null, upper: "6" },
  { id: "six-seven", label: "6.0 to below 7.0", lower: "6", upper: "7" },
  { id: "seven-eight", label: "7.0 to below 8.0", lower: "7", upper: "8" },
  { id: "eight-nine", label: "8.0 to below 9.0", lower: "8", upper: "9" },
  { id: "nine-ten", label: "9.0 and above", lower: "9", upper: null },
]);

export function decimal(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) return null;
  const [, sign, whole, fraction = "", exponent = "0"] = match;
  const shift = Number(exponent);
  if (!Number.isInteger(shift) || Math.abs(shift) > 1000) return null;
  const places = fraction.length - shift;
  return {
    units:
      BigInt(whole + fraction) *
      (sign ? -1n : 1n) *
      (places < 0 ? 10n ** BigInt(-places) : 1n),
    places: Math.max(0, places),
  };
}

export function compareDecimal(left, right) {
  const a = decimal(left),
    b = decimal(right);
  if (!a || !b) throw new Error("Invalid decimal comparison");
  const places = Math.max(a.places, b.places);
  const x = a.units * 10n ** BigInt(places - a.places);
  const y = b.units * 10n ** BigInt(places - b.places);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function validCgpa(value) {
  return (
    decimal(value) !== null &&
    compareDecimal(value, CGPA_SCALE.min) >= 0 &&
    compareDecimal(value, CGPA_SCALE.max) <= 0
  );
}

/** @returns {CategoryId|null} Null denotes data quality, never a fourth performance category. */
export function classifyCgpa(value) {
  if (!validCgpa(value)) return null;
  return CATEGORY_RULES.find(
    (rule) => rule.minimum === null || compareDecimal(value, rule.minimum) >= 0,
  ).id;
}

export const categoryDefinition = (id) =>
  CATEGORY_RULES.find((rule) => rule.id === id) || null;

// Only source-controlled column identifiers are accepted; all values are bound.
export function categorySql(column, bind) {
  if (!/^[a-z_]+\.[a-z_]+$/.test(column))
    throw new Error("Invalid CGPA column");
  const valid = `${column} BETWEEN ${bind(CGPA_SCALE.min)}::numeric AND ${bind(CGPA_SCALE.max)}::numeric`;
  const branches = CATEGORY_RULES.filter((rule) => rule.minimum !== null)
    .map(
      (rule) =>
        `WHEN ${column} >= ${bind(rule.minimum)}::numeric THEN ${bind(rule.id)}::text`,
    )
    .join(" ");
  return `CASE WHEN (${valid}) THEN CASE ${branches} ELSE ${bind(CATEGORY_RULES.at(-1).id)}::text END ELSE NULL END`;
}
