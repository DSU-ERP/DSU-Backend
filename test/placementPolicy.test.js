import test from 'node:test';
import assert from 'node:assert/strict';
import { placementEligibility, placementLabel, placementSql } from '../src/modules/analytics/placementPolicy.js';

test('placement eligibility uses precise valid CGPA only', () => {
  for (const value of ['10','9.25','8.50','8.499','8.49','7.5','6.75']) {
    assert.equal(placementEligibility(value), true, value);
  }
  for (const value of ['6.749999999999999999999','6.749','6.74','6.50','6.49','5','0']) {
    assert.equal(placementEligibility(value), false, value);
  }
  for (const value of [null,undefined,'',NaN,Infinity,'invalid','-0.01','10.001']) {
    assert.equal(placementEligibility(value), null, String(value));
  }
  assert.equal(placementLabel('6.75'), 'Eligible');
  assert.equal(placementLabel('6.749'), 'Not Eligible');
  assert.equal(placementLabel(null), 'Unclassified');
});
test('placement SQL binds its scale and threshold and rejects unsafe identifiers', () => {
  const values=[];
  const sql=placementSql('a.cgpa',v=>{values.push(v);return `$${values.length}`});
  assert.deepEqual(values,['0','10','6.75']);
  assert.match(sql,/ELSE NULL END/);
  assert.throws(()=>placementSql('cgpa; DROP TABLE',()=>''));
});
