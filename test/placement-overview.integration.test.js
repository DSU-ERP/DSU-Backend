import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { testDatabase } from "./helpers/database.js";

test("overview aggregation: search, distinct placements, empty scope and authorization", {timeout:120000}, async t => {
  const {db,pool}=await testDatabase();
  const officer=randomUUID(), outsider=randomUUID();
  await db.query("INSERT INTO auth.users(id) VALUES($1),($2)",[officer,outsider]);
  await db.query("INSERT INTO placement.officers(user_id) VALUES($1)",[officer]);
  const ids=[];
  for (const [index,cgpa] of [8.5,6.75,6.74,null].entries()) {
    const id=randomUUID(); ids.push(id);
    await db.query("INSERT INTO erp.students(id,enrollment_no,full_name,source_batch,source_hash,department_short_name) VALUES($1,$2,$3,'2027','fixture','CSE')",[id,`OV${index}`,index<2?`Target ${index}`:`Other ${index}`]);
    await db.query("INSERT INTO erp.academics(student_id,cgpa) VALUES($1,$2)",[id,cgpa]);
  }
  const app=await buildApp({pool,logger:false,env:{SERVICE_TOKEN:"x".repeat(32),RATE_LIMIT_USER_MAX:1000},verify:async token=>({id:token==="officer"?officer:outsider})});
  t.after(()=>app.close());
  const read=async(path,who="officer",status=200)=>{
    const r=await app.inject({url:`/api/v1/placement/${path}`,headers:{authorization:`Bearer ${who}`}});
    assert.equal(r.statusCode,status,r.body); return r.json().data;
  };
  const before=await read("overview/charts?batch=2027");
  assert.equal(before.kpis.placed,0);assert.equal(before.kpis.placementRate,0);
  const company=randomUUID(), drives=[randomUUID(),randomUUID()];
  await db.query("INSERT INTO placement.companies(id,name) VALUES($1,'Fixture company')",[company]);
  for(const drive of drives) await db.query("INSERT INTO placement.drives(id,company_id,title,package_lpa,academic_year,batch,rounds,status) VALUES($1,$2,'Fixture drive',8,'2026-27','2027','{HR}','upcoming')",[drive,company]);
  for(const [student,drive,status] of [[ids[0],drives[0],"accepted"],[ids[0],drives[1],"offered"],[ids[1],drives[0],"declined"]]) {
    const reg=randomUUID();
    await db.query("INSERT INTO placement.registrations(id,drive_id,student_id) VALUES($1,$2,$3)",[reg,drive,student]);
    await db.query("INSERT INTO placement.offers(registration_id,package_lpa,status) VALUES($1,8,$2)",[reg,status]);
  }
  const all=await read("overview/charts?batch=2027");
  assert.deepEqual([all.kpis.totalStudents,all.kpis.eligible,all.kpis.placed,all.kpis.activeOffers,all.kpis.acceptedOffers],[4,2,1,2,1]);
  assert.equal(all.kpis.placementRate,25); assert.equal(all.kpis.eligiblePlacementRate,50);
  assert.deepEqual(all.status.map(s=>s.count),[1,1,1,1]);
  assert.equal(all.status.reduce((sum,s)=>sum+s.count,0),all.kpis.totalStudents);
  assert.deepEqual(all.departments,[{department:"CSE",total:4,eligible:2,placed:1}]);
  const searched=await read("overview/charts?batch=2027&department=CSE&search=Target");
  const report=await read("overview?batch=2027&department=CSE&search=Target");
  assert.equal(searched.kpis.totalStudents,2);assert.equal(searched.kpis.totalStudents,report.summary.students);
  assert.equal(searched.kpis.placed,report.summary.placed); assert.equal(searched.filters.search,"Target");
  assert.equal(searched.status.reduce((sum,s)=>sum+s.count,0),2);
  assert.equal((await read("overview/charts?search=OV0")).kpis.totalStudents,1);
  const empty=await read("overview/charts?search=no-match");
  assert.equal(empty.kpis.totalStudents,0);assert.equal(empty.kpis.placementRate,null);assert.equal(empty.kpis.averageCgpa,null);
  await read("overview/charts?search=Target","outsider",403);
  await read("overview/charts?search="+"x".repeat(101),"officer",400);
});
