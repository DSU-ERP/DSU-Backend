export const LEVELS=['Attempted; not demonstrated','Foundational','Developing','Proficient','Advanced'];
export function assessDimensions(rubric,dimensions){
  if(!Array.isArray(rubric.dimensions)||!rubric.dimensions.length) throw new Error('Rubric has no criteria');
  const expected=rubric.dimensions.map(d=>d.key);
  if(new Set(expected).size!==expected.length) throw new Error('Duplicate rubric criterion');
  if(Object.keys(dimensions).length!==expected.length || expected.some(k=>!Object.hasOwn(dimensions,k))) throw new Error('All rubric criteria must be assessed');
  for(const value of Object.values(dimensions)) if(!Number.isInteger(value)||value<0||value>4) throw new Error('Criterion level must be an integer from 0 to 4');
  return expected.reduce((s,k)=>s+dimensions[k],0)/expected.length;
}
export const detailedDimensions={
 'SW-06':['Correctness','Input validation','Error handling','Database integration','Authorization','Tests','Documentation'],
 'MEC-01':['Geometry','Constraints','Engineering drawings','Parametric design','Manufacturability','Documentation'],
 'MKT-03':['Objectives','Audience','Budget','Channel selection','Messaging','Measurement'],
 'SAL-02':['Questions','Needs discovery','Listening','Qualification','Interpretation','Communication'],
};
export function proposedRubric(code,name){
 const labels=detailedDimensions[code]??['Demonstrated application','Correctness and validation','Independent contribution','Explanation and limitations'];
 return {code,name,version:1,status:'draft',method:'human_rubric',instructions:`Review an attributable ${name.toLowerCase()} work sample. Record observed behavior for every criterion. Missing evidence is not a zero. These proposed anchors require institutional review before operational assessment.`,dimensions:labels.map((label,i)=>({key:`criterion_${i+1}`,label,anchors:LEVELS.map((text,level)=>({level,text:`${label}: ${text}`}))}))};
}
