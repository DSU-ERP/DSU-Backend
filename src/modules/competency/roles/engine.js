// Only assessed competency inputs enter scoring, never academics or demographics.
export const ALGORITHM_VERSION = 'competency-alignment-v1';
export function validateRequirements(requirements) {
  if (!Array.isArray(requirements) || !requirements.length) throw new Error('Role requirements are not configured');
  const codes=new Set(); let total=0;
  for(const r of requirements){
    if(codes.has(r.code) || typeof r.code!=='string') throw new Error('Duplicate or invalid competency');
    codes.add(r.code);
    if(typeof r.weight!=='number' || !Number.isFinite(r.weight) || r.weight<=0 || r.weight>100) throw new Error('Invalid weight');
    if(!r.rubricId) throw new Error('A versioned rubric is required');
    total+=r.weight;
  }
  if(Math.abs(total-100)>1e-9) throw new Error('Role weights must total exactly 100');
  return requirements;
}
export function evaluateRole(template, assessments, {now=new Date(), simulated=false}={}) {
  const requirements=validateRequirements(template.requirements);
  const minimum=template.minimumCoverage??70;
  if(!Number.isFinite(minimum)||minimum<0||minimum>100) throw new Error('Invalid coverage threshold');
  const inputs=requirements.map(r=>{
    const candidates=assessments.filter(a=>a.code===r.code && a.rubricId===r.rubricId && a.assessmentSet===template.assessmentSet
      && a.simulated===simulated && a.status===(simulated?'simulated':'reviewed')
      && a.evidenceValid===true && !a.conflict && (!a.expiresAt || new Date(a.expiresAt)>now));
    const a=candidates.length===1?candidates[0]:null;
    const valid=a && typeof a.level==='number' && Number.isFinite(a.level) && a.level>=0 && a.level<=4;
    return {code:r.code,weight:r.weight,rubricId:r.rubricId,assessmentId:valid?a.id:null,
      level:valid?a.level:null,normalized:valid?a.level/4:null,contribution:valid?r.weight*a.level/4:null,
      reason:valid?null:candidates.length>1?'Conflicting assessments':'Not assessed with this standard'};
  });
  const coverage=inputs.reduce((s,r)=>s+(r.level===null?0:r.weight),0);
  const score=coverage?100*inputs.reduce((s,r)=>s+(r.contribution??0),0)/coverage:null;
  return {algorithmVersion:ALGORITHM_VERSION,templateId:template.id,assessmentSet:template.assessmentSet,
    minimumCoverage:minimum,coverage,alignment:score,simulated,
    state:coverage<minimum?'Needs Assessment':'Comparable within this assessment standard',
    comparisonKey:JSON.stringify([template.id,template.assessmentSet,simulated,inputs.filter(r=>r.level!==null).map(r=>[r.code,r.rubricId]).sort()]),
    calculatedAt:now.toISOString(),inputs,gaps:inputs.filter(r=>r.level===null).map(r=>r.code)};
}
export function rankComparable(rows) {
  const eligible=rows.filter(r=>r.result.coverage>=r.result.minimumCoverage && r.result.alignment!==null && !r.stale);
  const comparable=new Set(eligible.map(r=>r.result.comparisonKey)).size===1;
  const sorted=[...rows].sort((a,b)=>(b.result.alignment??-1)-(a.result.alignment??-1)||a.studentId.localeCompare(b.studentId));
  let previous=null,rank=0;
  return sorted.map(r=>{
    const canRank=comparable && eligible.includes(r);
    if(canRank && r.result.alignment!==previous){rank++;previous=r.result.alignment;}
    return {...r,rank:canRank?rank:null,comparison:canRank?'Comparable':r.stale?'Stale':r.result.coverage<r.result.minimumCoverage?'Needs Assessment':'Not Comparable'};
  });
}
