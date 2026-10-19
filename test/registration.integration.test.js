import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {withActor} from '../src/integrations/supabase/db.js';
import {testDatabase} from './helpers/database.js';

test('verified student registration protects official records and role boundaries', {timeout:120000}, async t=>{
  const {db,pool}=await testDatabase();
  const app=await buildApp({pool,logger:false,env:{SERVICE_TOKEN:'x'.repeat(32),RATE_LIMIT_USER_MAX:10000},verify:async id=>({id})});
  t.after(()=>app.close());
  async function user(email,verified=true){
    const id=randomUUID();
    await db.query(`INSERT INTO auth.users(id,email,email_confirmed_at,raw_user_meta_data) VALUES($1,$2,$3,$4)`,[id,email,verified?new Date().toISOString():null,JSON.stringify({full_name:'New Student',role:'placement_officer'})]);
    return id;
  }
  async function record(email){
    const id=randomUUID();
    await db.query(`INSERT INTO erp.students(id,enrollment_no,full_name,department_name,course_name,current_semester,source_batch,source_hash) VALUES($1,$2,'Official Student','Computer Science','B.Tech','6','2028','fixture')`,[id,'USN-'+id.slice(0,8)]);
    await db.query('INSERT INTO erp.academics(student_id,cgpa,current_backlog,fees_paid) VALUES($1,8.5,0,12345)',[id]);
    await db.query('INSERT INTO erp.contacts(student_id,details) VALUES($1,$2)',[id,JSON.stringify({email,phoneStudent1:'0000000000',presentCity:'Bengaluru',fatherName:'Private family detail'})]);
    return id;
  }
  async function request(id,body,expected=200,path='/onboarding'){
    const response=await app.inject({url:'/api/v1'+path,method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+id},payload:body});
    assert.equal(response.statusCode,expected,response.body);
    return response.json().data;
  }
  const payload=(overrides={})=>({details:{fullName:'Self reported name',department:'Self reported department',program:'B.Tech',interests:['Software engineering'],dreamRoles:'Software engineer',github:'https://github.com/example'},academic:{enrollmentNo:'TYPED-USN',yearOfStudy:'3',cgpa:'10'},step:4,revision:0,complete:true,consent:true,...overrides});
  let matchedUser,matchedId;
  await t.test('only a verified email reveals its unique official match',async()=>{
    matchedId=await record('  Student@university.invalid  ');
    matchedUser=await user('student@university.invalid',false);
    const hidden=await request(matchedUser);
    assert.equal(hidden.state,'verify_email');assert.equal(hidden.official,undefined);
    await request(matchedUser,payload(),403);
    await db.query('UPDATE auth.users SET email_confirmed_at=now() WHERE id=$1',[matchedUser]);
    const matched=await request(matchedUser);
    assert.equal(matched.state,'matched');assert.equal(matched.official.id,matchedId);
    assert.equal(matched.official.phone,'0000000000');assert.equal(matched.official.cgpa,'8.5');
    assert.equal(matched.official.fatherName,undefined);assert.equal(matched.official.fees_paid,undefined);
    assert.equal((await request(matchedUser,undefined,200,'/session')).role,null);
  });
  await t.test('drafts resume privately and stale writes are rejected',async()=>{
    const first=await request(matchedUser,payload({step:2,complete:false}));
    assert.equal(first.revision,1);assert.equal(first.home,null);
    const restored=await request(matchedUser);
    assert.equal(restored.draft.step,2);assert.equal(restored.draft.details.fullName,'Official Student');
    assert.equal(restored.draft.academic.cgpa,'8.5');
    await request(matchedUser,payload({complete:false}),409);
    const stranger=await user('stranger@university.invalid');
    assert.equal((await request(stranger)).draft,null);
    await withActor(pool,stranger,async client=>{
      assert.equal((await client.query('SELECT * FROM student.registration_drafts WHERE user_id=$1',[matchedUser])).rows.length,0);
      assert.equal((await client.query("UPDATE student.registration_drafts SET step=0 WHERE user_id=$1 RETURNING user_id",[matchedUser])).rows.length,0);
    });
  });
  await t.test('completion links the exact verified record and never changes academics',async()=>{
    const result=await request(matchedUser,payload({revision:1}));
    assert.equal(result.status,'completed');assert.equal(result.home,'/student/dashboard');
    assert.deepEqual((await db.query('SELECT role,student_id FROM erp.memberships WHERE user_id=$1',[matchedUser])).rows[0],{role:'student',student_id:matchedId});
    assert.equal((await request(matchedUser,undefined,200,'/session')).role,'student');
    const saved=(await request(matchedUser)).profile;
    assert.equal(saved.onboarded,true);assert.equal(saved.details.department,'Computer Science');
    assert.deepEqual(saved.details.interests,['Software engineering']);
    assert.equal((await db.query('SELECT cgpa::text FROM erp.academics WHERE student_id=$1',[matchedId])).rows[0].cgpa,'8.5');
    assert.equal((await db.query("SELECT count(*)::int AS count FROM erp.audit_events WHERE actor_id=$1 AND action='student.email_verified_link'",[matchedUser])).rows[0].count,1);
  });
  await t.test('claimed records and duplicate emails reveal no student data',async()=>{
    const claimed=await user('student@university.invalid');
    const context=await request(claimed);assert.equal(context.state,'review');assert.equal(context.official,undefined);
    await record('duplicate@university.invalid');await record('duplicate@university.invalid');
    const duplicate=await user('duplicate@university.invalid');
    const duplicateContext=await request(duplicate);assert.equal(duplicateContext.state,'review');assert.equal(duplicateContext.official,undefined);
    await request(duplicate,payload(),409); // unknown typed USN
    assert.equal((await request(duplicate,undefined,200,'/session')).role,null);
  });
  await t.test('unknown email links by USN once, without manual verification',async()=>{
    const unknown=await user('new@university.invalid');
    const input=payload();input.academic.enrollmentNo=(await request(matchedUser)).official.enrollment_no;
    await request(unknown,input,409); // already claimed by another account
    await request(unknown,{...input,academic:{...input.academic,enrollmentNo:'NOPE-404'}},409);
    assert.equal((await db.query('SELECT * FROM erp.memberships WHERE user_id=$1',[unknown])).rows.length,0);
    await request(unknown,{...input,email:'student@university.invalid'},400);
    await request(unknown,{...input,role:'placement_officer'},400);
    await request(unknown,{...input,consent:false},400);
    const free=await record('someone-else@university.invalid');
    const usn=(await db.query('SELECT enrollment_no FROM erp.students WHERE id=$1',[free])).rows[0].enrollment_no;
    const done=await request(unknown,{...input,academic:{...input.academic,enrollmentNo:usn.toLowerCase()}});
    assert.equal(done.status,'completed');assert.equal(done.home,'/student/dashboard');
    assert.deepEqual((await db.query('SELECT role,student_id FROM erp.memberships WHERE user_id=$1',[unknown])).rows[0],{role:'student',student_id:free});
    assert.equal((await request(unknown)).profile.details.fullName,'Official Student');
    assert.equal((await request(unknown,undefined,200,'/session')).role,'student');
  });
  await t.test('a verified university email matches its USN automatically',async()=>{
    const id=await record('personal@gmail.invalid');
    const usn=(await db.query('SELECT enrollment_no FROM erp.students WHERE id=$1',[id])).rows[0].enrollment_no;
    const uni=await user(usn.toLowerCase()+'@dsu.edu.in');
    assert.equal((await request(uni)).official.id,id);
  });
  await t.test('students awaiting review can finish after a campus record is imported',async()=>{
    const late=await user('late@university.invalid');await request(late,payload(),409);
    const imported=await record('late@university.invalid');
    assert.equal((await request(late)).official.id,imported);
    assert.equal((await request(late,payload())).status,'completed');
  });
  await t.test('officers and other assigned roles cannot self-register as students',async()=>{
    const officer=await user('officer@university.invalid');await db.query('INSERT INTO placement.officers(user_id) VALUES($1)',[officer]);
    assert.equal((await request(officer)).state,'officer');await request(officer,payload(),403);
    const admin=await user('admin@university.invalid');await db.query("INSERT INTO erp.memberships(user_id,role) VALUES($1,'admin')",[admin]);
    assert.equal((await request(admin)).state,'restricted');await request(admin,payload(),403);
    const anonymous=await app.inject('/api/v1/onboarding');assert.equal(anonymous.statusCode,401);
    for(const role of ['anon','authenticated']){
      const result=await db.query("SELECT has_function_privilege($1,'student.registration_context()','EXECUTE') AS allowed,has_function_privilege($1,'student.link_registration()','EXECUTE') AS linking",[role]);
      assert.deepEqual(result.rows[0],{allowed:false,linking:false});
    }
  });
});
