import { CGPA_SCALE, validCgpa, compareDecimal } from './categoryRules.js';

// Institution rule confirmed by the user: CGPA only; no backlog/attendance gate.
export const PLACEMENT_POLICY = Object.freeze({
  configured: true,
  minimumCgpa: '6.75',
  label: 'Valid CGPA 6.75 and above',
});
export function placementEligibility(value) {
  return validCgpa(value) ? compareDecimal(value, PLACEMENT_POLICY.minimumCgpa) >= 0 : null;
}
export function placementSql(column, bind) {
  if (!/^[a-z_]+\.[a-z_]+$/.test(column)) throw new Error('Invalid CGPA column');
  return `CASE WHEN ${column} BETWEEN ${bind(CGPA_SCALE.min)}::numeric AND ${bind(CGPA_SCALE.max)}::numeric THEN ${column} >= ${bind(PLACEMENT_POLICY.minimumCgpa)}::numeric ELSE NULL END`;
}
export function placementLabel(value) {
  const eligible=placementEligibility(value);
  return eligible === null ? 'Unclassified' : eligible ? 'Eligible' : 'Not Eligible';
}
